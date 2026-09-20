"""
Nginx route management — local-only (no SSH).

Logic adapted from jazzmind/busibox srv/deploy/src/nginx_config.py.
Generates path-based location blocks, writes them to a per-app .conf file,
validates with `nginx -t`, and reloads.

Config dir defaults to /etc/nginx/app-locations (matches busibox convention).
Each app gets:  location ^~ /{app_id}  →  proxy_pass http://127.0.0.1:{port};

Per-app access control (AppSpec.allowed_emails) is enforced with a plain incoming-header
check ($http_x_forwarded_email), not nginx's auth_request module -- oauth2-proxy runs as
the actual reverse proxy in front of nginx (see bootstrap-sandbox.sh), so
X-Forwarded-Email already arrives as a normal request header on every location, including
this one; nothing here makes a subrequest. See docs/implementation-status.md for why
auth_request itself was tried first and doesn't work in this nginx/Docker combination.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

# Matches busibox NGINX_CONFIG_DIR env var convention
_DEFAULT_CONFIG_DIR = Path(os.environ.get("NGINX_CONFIG_DIR", "/etc/nginx/app-locations"))
_DEFAULT_PUBLIC_URL = os.environ.get("DEPLOYKIT_PUBLIC_URL", "http://localhost")

# Docker mode: when set, use docker exec for nginx reload/validate and Docker DNS for upstreams
_NGINX_CONTAINER_NAME = os.environ.get("NGINX_CONTAINER_NAME", "")
_DEPLOYKIT_DOCKER_NETWORK = os.environ.get("DEPLOYKIT_DOCKER_NETWORK", "")

# Included inside a server{} block, so upstream{} is not valid here.
# Docker network mode: use resolver + variable so nginx re-resolves on container restart.
# Host port mode: plain proxy_pass to 127.0.0.1:{port}.
_LOCATION_TEMPLATE_DOCKER = """\
# deploykit managed — do not edit manually (app_id={app_id})
# Use Docker's embedded resolver + variable so nginx resolves the container
# hostname at request time (not at startup, when the container may not exist).
# Match the bare prefix (no trailing slash) so the basePath root is served too:
# Next.js (trailingSlash:false) canonicalises /{app_id}/ -> /{app_id}, and that
# bare request must still reach the container instead of bouncing to the catch-all.
# proxy_pass with a variable + no URI part forwards the full original URI intact.
location ^~ {path_prefix} {{
    resolver 127.0.0.11 valid=10s;
{acl_block}    set $backend "{upstream_server}";
    proxy_pass http://$backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}}
"""

_LOCATION_TEMPLATE_HOST = """\
# deploykit managed — do not edit manually (app_id={app_id})
# Match the bare prefix (no trailing slash) so the basePath root is served too:
# Next.js (trailingSlash:false) canonicalises /{app_id}/ -> /{app_id}, and that
# bare request must still reach the container instead of bouncing to the catch-all.
location ^~ {path_prefix} {{
{acl_block}    proxy_pass http://{upstream_server};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}}
"""

_EMAIL_SAFE_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")


def _acl_block(allowed_emails: list[str] | None) -> str:
    """Per-app access-control snippet, or "" (no restriction) when the list is empty.

    Reads $http_x_forwarded_email directly -- a plain incoming header, already present on
    every location because oauth2-proxy sits in front of nginx as the actual reverse proxy
    (not an auth_request subrequest target; see the module docstring). error_page must be
    a sibling of the `if`, not nested inside it -- nginx's `if` only reliably honors
    return/rewrite/set, and error_page placed inside it is silently ignored (verified
    live: the response fell through to nginx's bare default 403 page instead of the
    branded one). "=403" (no space before the code) preserves the actual status; a bare
    "=" takes on whatever /unauthorized itself returns, which is 200 for an existing file.
    """
    if not allowed_emails:
        return ""
    for email in allowed_emails:
        if not _EMAIL_SAFE_RE.match(email):
            raise ValueError(f"allowed_emails entries must be plain email addresses: {email!r}")
    # Escaped for regex safety: unescaped "." and "+" are metacharacters, so e.g.
    # "a.b@x.com" would also match "axb@x.com" without this.
    escaped = "|".join(re.escape(e.lower()) for e in allowed_emails)
    return (
        f'    error_page 403 =403 /unauthorized;\n'
        f'    if ($http_x_forwarded_email !~* "^({escaped})$") {{\n'
        f'        return 403;\n'
        f'    }}\n'
    )


async def _run(cmd: list[str], check: bool = True) -> tuple[int, str, str]:
    # A missing binary (no nginx on PATH, no systemctl on macOS) raises FileNotFoundError
    # from create_subprocess_exec itself — a different exception than a nonzero exit code,
    # and previously uncaught here. Normalize it: with check=True this is a real failure
    # (matches every existing `except RuntimeError` call site); with check=False it behaves
    # like "command ran and failed" (rc=127) so a caller's own fallback logic still runs
    # instead of the exception escaping past it.
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        message = f"command not found: {cmd[0]}"
        if check:
            raise RuntimeError(f"nginx cmd failed: {' '.join(cmd)}\n{message}")
        return 127, "", message
    stdout, stderr = await proc.communicate()
    rc = proc.returncode or 0
    out, err = stdout.decode().strip(), stderr.decode().strip()
    if check and rc != 0:
        raise RuntimeError(f"nginx cmd failed: {' '.join(cmd)}\n{err}")
    return rc, out, err


class NginxProxy:
    def __init__(
        self,
        config_dir: Path | None = None,
        public_url: str | None = None,
    ) -> None:
        self.config_dir = config_dir or _DEFAULT_CONFIG_DIR
        self.public_url = (public_url or _DEFAULT_PUBLIC_URL).rstrip("/")

    def _conf_path(self, app_id: str) -> Path:
        return self.config_dir / f"{app_id}.conf"

    def generate_location_block(
        self,
        app_id: str,
        path_prefix: str,
        backend_port: int,
        container_port: int | None = None,
        allowed_emails: list[str] | None = None,
    ) -> str:
        acl_block = _acl_block(allowed_emails)
        if _DEPLOYKIT_DOCKER_NETWORK and container_port is not None:
            return _LOCATION_TEMPLATE_DOCKER.format(
                app_id=app_id,
                path_prefix=path_prefix.rstrip("/"),
                upstream_server=f"dk-{app_id}:{container_port}",
                acl_block=acl_block,
            )
        return _LOCATION_TEMPLATE_HOST.format(
            app_id=app_id,
            path_prefix=path_prefix.rstrip("/"),
            upstream_server=f"127.0.0.1:{backend_port}",
            acl_block=acl_block,
        )

    async def add_route(
        self,
        app_id: str,
        path_prefix: str,
        backend_port: int,
        container_port: int | None = None,
        allowed_emails: list[str] | None = None,
    ) -> str:
        """Write location block, validate, reload. Returns the public URL."""
        self.config_dir.mkdir(parents=True, exist_ok=True)
        conf = self.generate_location_block(app_id, path_prefix, backend_port, container_port, allowed_emails)
        self._conf_path(app_id).write_text(conf)

        try:
            await self._validate()
            await self._reload()
        except RuntimeError:
            # Roll back the bad config so nginx stays running
            self._conf_path(app_id).unlink(missing_ok=True)
            await self._reload()
            raise

        return f"{self.public_url}{path_prefix.rstrip('/')}/"

    async def remove_route(self, app_id: str) -> None:
        """Remove location block and reload."""
        self._conf_path(app_id).unlink(missing_ok=True)
        # Don't raise if nginx isn't available (e.g., during tests)
        try:
            await self._validate()
            await self._reload()
        except RuntimeError:
            pass

    async def _validate(self) -> None:
        if _NGINX_CONTAINER_NAME:
            await _run(["docker", "exec", _NGINX_CONTAINER_NAME, "nginx", "-t"])
        else:
            await _run(["nginx", "-t"])

    async def _reload(self) -> None:
        if _NGINX_CONTAINER_NAME:
            await _run(["docker", "exec", _NGINX_CONTAINER_NAME, "nginx", "-s", "reload"])
        else:
            # Try systemctl first (standard on systemd hosts), fall back to nginx -s reload
            rc, _, _ = await _run(["systemctl", "reload", "nginx"], check=False)
            if rc != 0:
                await _run(["nginx", "-s", "reload"])

    async def list_routes(self) -> list[dict]:
        """Return the app_id and path for every managed conf file."""
        if not self.config_dir.exists():
            return []
        routes = []
        for f in sorted(self.config_dir.glob("*.conf")):
            text = f.read_text()
            app_id = f.stem
            path_line = next(
                (line for line in text.splitlines() if "location ^~" in line), ""
            )
            path_prefix = path_line.split("location ^~")[-1].strip().rstrip("/{")
            routes.append({"app_id": app_id, "path_prefix": path_prefix or f"/{app_id}"})
        return routes
