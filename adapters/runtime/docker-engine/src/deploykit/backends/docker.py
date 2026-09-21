"""
Docker backend — one isolated container per app.

Design:
  - Each app runs as its own `docker run` container (better isolation than busibox's
    shared user-apps+supervisord model).
  - Containers are named `dk-{app_id}` for easy lookup.
  - After successful start, calls proxy.nginx to register the route.
  - Port allocation delegated to deploykit.ports (file-locked, range 4100-4999).
  - State persisted to deploykit.store.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from ..models import (
    AppSpec,
    AppSummary,
    DeploymentEvent,
    DeploymentResult,
    DeploymentStatus,
)
from ..ports import PortAllocator
from ..proxy.nginx import NginxProxy
from ..store import DeploymentStore
from .base import DeployBackend

# Renamed 2026-09-20 from "dk" (short for the former standalone deploykit repo this engine
# was vendored out of) -- deployed-app containers are now named pac-<app_id>, matching the
# rest of this vendored engine's rename away from deploykit branding (see docker-net -> pac-net
# etc. in pracman/envs/local/*.sh).
CONTAINER_PREFIX = "pac"
WORKDIR_BASE = Path(os.environ.get("DEPLOYKIT_WORKDIR", "/srv/deploykit/apps"))
CLONE_TIMEOUT = 120
BUILD_TIMEOUT = 300
START_TIMEOUT = 60
RESTART_TIMEOUT = 60
HEALTH_CHECK_TIMEOUT = 60
# Sync-capable containers install deps + build at container start (not image-build
# time), which can comfortably exceed a minute (observed: npm ci alone ~53s on a
# bind mount, before `next build` even starts) — give them a much longer runway.
SYNC_CAPABLE_HEALTH_CHECK_TIMEOUT = 240

# When set, app containers join this Docker network and are reachable by name (no host port binding)
_DOCKER_NETWORK = os.environ.get("DEPLOYKIT_DOCKER_NETWORK", "")

# deploykit itself typically runs inside a container with WORKDIR_BASE bind-mounted
# from this host path. New sibling containers created via the host's Docker socket
# resolve bind-mount sources against the HOST filesystem, not deploykit's own
# internal view — so mounts for sync-capable containers must use this path, not
# WORKDIR_BASE. Defaults to WORKDIR_BASE for non-containerized/dev deploykit runs.
_HOST_APPS_DIR = os.environ.get("DEPLOYKIT_HOST_APPS_DIR", str(WORKDIR_BASE))

SYNC_CAPABLE_LABEL = "deploykit.sync_capable"
HEALTH_ENDPOINT_LABEL = "deploykit.health_endpoint"
CONTAINER_PORT_LABEL = "deploykit.container_port"


def _container_name(app_id: str) -> str:
    return f"{CONTAINER_PREFIX}-{app_id}"


def _host_app_dir(local_path: str) -> str:
    """Host-filesystem path for a local-source app's directory (for bind mounts)."""
    return f"{_HOST_APPS_DIR.rstrip('/')}/{local_path}"


def _node_modules_volume(app_id: str) -> str:
    return f"{CONTAINER_PREFIX}-{app_id}-node_modules"


def _sync_state_volume(app_id: str) -> str:
    return f"{CONTAINER_PREFIX}-{app_id}-sync-state"


def _event(deployment_id: str, msg: str, level: str = "info") -> DeploymentEvent:
    return DeploymentEvent(deployment_id=deployment_id, message=msg, level=level)


async def _run(
    cmd: list[str],
    timeout: int = 60,
    check: bool = True,
    cwd: Path | None = None,
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
    rc = proc.returncode or 0
    out, err = stdout.decode().strip(), stderr.decode().strip()
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {' '.join(cmd)}\n{err or out}")
    return rc, out, err


async def _stream_run(
    cmd: list[str],
    timeout: int,
    cwd: Path | None = None,
) -> AsyncIterator[str]:
    """Run a command, yielding each output line as it is produced.

    stderr is merged into stdout so build tools (docker buildkit, npm, etc.)
    that write progress/errors to stderr are captured in order. Raises
    RuntimeError on non-zero exit (after all output has been yielded) so the
    caller has already surfaced the failing output before the exception.
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(cwd) if cwd else None,
    )
    assert proc.stdout is not None
    deadline = time.time() + timeout
    tail: list[str] = []  # keep last lines for the exception message
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            proc.kill()
            raise RuntimeError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
        try:
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
        if not raw:
            break
        line = raw.decode(errors="replace").rstrip()
        tail.append(line)
        if len(tail) > 40:
            tail.pop(0)
        yield line
    await proc.wait()
    if proc.returncode != 0:
        detail = "\n".join(tail[-10:])
        raise RuntimeError(
            f"Command failed (rc={proc.returncode}): {' '.join(cmd[:3])}…\n{detail}"
        )


def _bg_upsert(store: "DeploymentStore", *args, **kwargs) -> None:
    """Fire-and-forget store upsert — never blocks the generator."""
    async def _do() -> None:
        try:
            await store.upsert(*args, **kwargs)
        except Exception:
            pass
    asyncio.create_task(_do())


class DockerBackend(DeployBackend):
    def __init__(
        self,
        store: DeploymentStore,
        ports: PortAllocator,
        nginx: NginxProxy,
    ) -> None:
        self._store = store
        self._ports = ports
        self._nginx = nginx

    # ------------------------------------------------------------------
    # DeployBackend interface
    # ------------------------------------------------------------------

    async def deploy(
        self,
        spec: AppSpec,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        return self._deploy_stream(spec, deployment_id, deployed_by)

    async def _deploy_stream(
        self,
        spec: AppSpec,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        ev = lambda msg, level="info": _event(deployment_id, msg, level)

        _bg_upsert(self._store, deployment_id, spec.id, DeploymentStatus.PENDING)

        # --- allocate port ---
        yield ev(f"Allocating port for {spec.id}...")
        port = await self._ports.allocate(spec.id, preferred=spec.port)
        yield ev(f"Port {port} assigned")

        # --- remove existing container (force-stops running/restarting containers too) ---
        container_name = _container_name(spec.id)
        existing = await self._container_id(spec.id)
        if existing:
            yield ev(f"Removing existing container {existing[:12]}", "warn")
            await _run(["docker", "rm", "-f", container_name], check=False)

        # --- build or pull image ---
        _bg_upsert(self._store, deployment_id, spec.id, DeploymentStatus.BUILDING)

        # Set only for local_path/repo_url deploys — stays None for a pure
        # `image` pull, since there is no on-disk source to readiness-scan.
        app_dir: Path | None = None

        if spec.local_path:
            app_dir = WORKDIR_BASE / spec.local_path
            if not app_dir.exists():
                raise RuntimeError(
                    f"Local source not found: {app_dir}. "
                    "Ensure the rsync from your local machine completed successfully."
                )
            yield ev(f"Building from local source: {app_dir}")

            if spec.build_command:
                yield ev(f"Running build: {spec.build_command}")
                async for line in _stream_run(
                    ["/bin/bash", "-c", spec.build_command],
                    cwd=app_dir,
                    timeout=BUILD_TIMEOUT,
                ):
                    yield ev(line)

            image_tag = f"deploykit/{spec.id}:latest"
            dockerfile = app_dir / spec.dockerfile
            yield ev(f"Building Docker image {image_tag}...")
            async for line in _stream_run(
                ["docker", "build", "--no-cache", "-f", str(dockerfile), "-t", image_tag, str(app_dir)],
                timeout=BUILD_TIMEOUT,
            ):
                yield ev(line)
            image = image_tag

        elif spec.repo_url:
            app_dir = WORKDIR_BASE / spec.id
            app_dir.mkdir(parents=True, exist_ok=True)

            yield ev(f"Cloning {spec.repo_url} ({spec.repo_branch})...")
            if (app_dir / ".git").exists():
                await _run(
                    ["git", "-C", str(app_dir), "fetch", "--depth=1", "origin", spec.repo_branch],
                    timeout=CLONE_TIMEOUT,
                )
                await _run(
                    ["git", "-C", str(app_dir), "reset", "--hard", f"origin/{spec.repo_branch}"],
                )
            else:
                await _run(
                    ["git", "clone", "--depth=1", "-b", spec.repo_branch, spec.repo_url, str(app_dir)],
                    timeout=CLONE_TIMEOUT,
                )
            yield ev("Clone complete")

            if spec.build_command:
                yield ev(f"Running build: {spec.build_command}")
                async for line in _stream_run(
                    ["/bin/bash", "-c", spec.build_command],
                    cwd=app_dir,
                    timeout=BUILD_TIMEOUT,
                ):
                    yield ev(line)

            image_tag = f"deploykit/{spec.id}:latest"
            dockerfile = app_dir / spec.dockerfile
            yield ev(f"Building Docker image {image_tag}...")
            async for line in _stream_run(
                ["docker", "build", "--no-cache", "-f", str(dockerfile), "-t", image_tag, str(app_dir)],
                timeout=BUILD_TIMEOUT,
            ):
                yield ev(line)
            image = image_tag
        else:
            image = spec.image
            yield ev(f"Pulling image {image}...")
            async for line in _stream_run(["docker", "pull", image], timeout=BUILD_TIMEOUT):
                yield ev(line)

        # --- run container ---
        _bg_upsert(self._store, deployment_id, spec.id, DeploymentStatus.STARTING)
        yield ev("Starting container...")

        # Auto-provision datastores declared via SANDBOX_*_TOKEN sentinels in
        # env_vars. Each provisioner normalizes its token(s) to a
        # {token: result_key} mapping — Postgres has a single token mapping to
        # the whole db_url string; DynamoDB has five tokens each mapping to a
        # different field of its result dict. When ANY of a provisioner's
        # tokens appear in resolved_env_vars, it is called once and every
        # matching token is substituted with the corresponding field from its
        # result. Provisioners are independent: a Postgres failure never
        # blocks a DynamoDB provision in the same deploy (or vice versa) —
        # each is caught, warned, and skipped on its own.
        from ..postgres import SANDBOX_DB_TOKEN, DK_DB_TOKEN, provision_db as _pg_provision
        from ..dynamodb import SANDBOX_DDB_TOKENS, DK_DDB_TOKENS, provision_store as _ddb_provision
        import logging as _logging
        _prov_log = _logging.getLogger(__name__)

        # kind → {endpoint result dict}, populated only for provisioners that
        # actually ran this deploy — used below to persist into `extra`.
        _provision_results: dict[str, dict] = {}

        # Corrected 2026-09-20: each provisioner now accepts EITHER its old {{SANDBOX_*}}
        # sentinel or the new, target-neutral {{DK_*}} one -- both map to the same result
        # field, so an app.json written before or after the rename substitutes identically.
        _PROVISIONERS = [
            # (kind, label, done_label, {token: result_key}, provision_fn)
            ("postgres", "Postgres database", "Database provisioned",
             {SANDBOX_DB_TOKEN: "db_url", DK_DB_TOKEN: "db_url"}, _pg_provision),
            ("dynamodb", "DynamoDB store", "DynamoDB store provisioned",
             {**SANDBOX_DDB_TOKENS, **DK_DDB_TOKENS}, _ddb_provision),
        ]

        # Sandbox-level SSO credentials, injected as defaults so app builders never
        # handle these secrets — an explicit spec.env_vars entry always overrides.
        from ..sso_env import sandbox_sso_env
        resolved_env_vars = {**sandbox_sso_env(), **spec.env_vars}

        for _kind, _label, _done_label, _tokens, _provision_fn in _PROVISIONERS:
            if not any(v in _tokens for v in resolved_env_vars.values()):
                continue
            yield ev(f"Provisioning {_label} for {spec.id}...")
            try:
                _result = await _provision_fn(spec.id)
                resolved_env_vars = {
                    k: (_result[_tokens[v]] if v in _tokens else v)
                    for k, v in resolved_env_vars.items()
                }
                _provision_results[_kind] = _result
                yield ev(f"{_done_label}: {spec.id}")
            except Exception as _exc:
                _prov_log.warning("%s provisioning failed for %s: %s", _label, spec.id, _exc)
                # Provisioning failed — resolved_env_vars still holds the raw,
                # unresolved "{{TOKEN}}" placeholder strings for this
                # provisioner (they were never substituted). Baking those
                # literally into the container — e.g.
                # AWS_REGION="{{SANDBOX_DDB_REGION}}" — is worse than leaving
                # the var unset: the app's own AWS/DB client sees a non-empty,
                # syntactically-invalid value and fails hard on every request,
                # instead of falling back gracefully the way an absent env var
                # would. Strip every key whose value is still one of this
                # provisioner's tokens so "Deploying without it" is actually
                # true, not just the log message.
                resolved_env_vars = {
                    k: v for k, v in resolved_env_vars.items() if v not in _tokens
                }
                yield ev(
                    f"Warning: {_label} provisioning failed — {_exc}. Deploying without it.",
                    "warn",
                )

        env_args: list[str] = []
        merged_env = {"PORT": str(spec.port), **resolved_env_vars}
        for k, v in merged_env.items():
            env_args.extend(["-e", f"{k}={v}"])

        label_args: list[str] = []
        sync_capable = bool(spec.local_path) and spec.sync_capable
        all_labels = {
            "deploykit.app_id": spec.id,
            "deploykit.deployment_id": deployment_id,
            SYNC_CAPABLE_LABEL: "true" if sync_capable else "false",
            HEALTH_ENDPOINT_LABEL: spec.health_endpoint,
            CONTAINER_PORT_LABEL: str(spec.port),
            **spec.labels,
        }
        for k, v in all_labels.items():
            label_args.extend(["--label", f"{k}={v}"])

        network_args = ["--network", _DOCKER_NETWORK] if _DOCKER_NETWORK else []
        # In Docker network mode nginx reaches the app via Docker DNS; no host port binding needed
        port_args = [] if _DOCKER_NETWORK else ["-p", f"127.0.0.1:{port}:{spec.port}"]

        # Sync-capable apps bind-mount live source over the image's /app so a plain
        # rsync + `docker restart` (sync()) picks up new code with no image build.
        # node_modules gets its own named volume so it survives restarts and isn't
        # shadowed by the (rsync-excluded, host-side empty) source directory.
        # /app/.deploykit-state (start.sh's dependency lockhash) gets the same
        # treatment — it lives inside /app so the local dev machine's rsync
        # --delete would otherwise wipe it every sync (it never exists locally),
        # forcing a needless npm ci re-run on every restart.
        mount_args: list[str] = []
        cap_add_args = ["--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID"]
        if sync_capable:
            mount_args = [
                "-v", f"{_host_app_dir(spec.local_path)}:/app",
                "-v", f"{_node_modules_volume(spec.id)}:/app/node_modules",
                "-v", f"{_sync_state_volume(spec.id)}:/app/.deploykit-state",
            ]
            # The bind-mounted source dir is owned by the host deploy user (e.g.
            # aillmuser), not container-root. Without DAC_OVERRIDE, root can't
            # bypass that ownership check and npm ci/install fails with EACCES
            # writing package-lock.json / node_modules. Baked-image (non-sync)
            # containers never touch a host-owned path, so they don't need this.
            cap_add_args += ["--cap-add", "DAC_OVERRIDE"]

        docker_cmd = [
            "docker", "run", "-d",
            "--name", _container_name(spec.id),
            "--restart", "unless-stopped",
            "--log-driver", "json-file",
            "--log-opt", "max-size=10m",
            "--log-opt", "max-file=3",
            "--memory", spec.memory_limit,
            "--cpus", spec.cpu_limit,
            "--security-opt", "no-new-privileges:true",
            "--cap-drop", "ALL",
            *cap_add_args,
            *network_args,
            *port_args,
            *mount_args,
            *env_args,
            *label_args,
            image,
        ]
        if spec.start_command:
            docker_cmd.extend(["/bin/sh", "-c", spec.start_command])

        _, container_id, _ = await _run(docker_cmd, timeout=START_TIMEOUT)
        container_id = container_id.strip()
        yield ev(f"Container started: {container_id[:12]}")

        # --- health check with early crash detection ---
        if _DOCKER_NETWORK:
            check_host = await self._get_container_ip_by_id(container_id, _DOCKER_NETWORK) or "127.0.0.1"
            check_port = spec.port
        else:
            check_host = "127.0.0.1"
            check_port = port
        yield ev(f"Waiting for http://{check_host}:{check_port}{spec.health_endpoint}...")
        health_timeout = SYNC_CAPABLE_HEALTH_CHECK_TIMEOUT if sync_capable else HEALTH_CHECK_TIMEOUT
        healthy, crash_reason = await self._wait_healthy_or_crash(
            container_id, check_host, check_port, spec.health_endpoint, timeout=health_timeout
        )
        if not healthy:
            _, logs, logs_err = await _run(["docker", "logs", "--tail", "60", container_id], check=False)
            await _run(["docker", "rm", "-f", container_name], check=False)
            await self._ports.release(spec.id)
            reason = crash_reason or "health check timed out"
            # Emit all output before the store call so nothing blocks the stream
            yield ev(f"Container failed: {reason}", "error")
            log_output = (logs or "").strip()
            if log_output:
                yield ev("── container logs ──", "warn")
                for line in log_output.splitlines()[-60:]:
                    yield ev(line, "error")
                yield ev("── end of logs ──", "warn")
            elif logs_err and "logging driver does not support reading" in logs_err:
                yield ev("── container logs unavailable (daemon logging driver is write-only) ──", "warn")
                yield ev("Tip: check 'journalctl -u docker' on the sandbox or ask the container to write to stdout", "warn")
            _bg_upsert(self._store, deployment_id, spec.id, DeploymentStatus.FAILED, error=reason)
            return

        # --- nginx route ---
        yield ev("Registering nginx route...")
        url = await self._nginx.add_route(
            app_id=spec.id,
            path_prefix=spec.effective_path,
            backend_port=port,
            container_port=spec.port,
            allowed_emails=spec.allowed_emails or None,
        )
        yield ev(f"App live at {url}")

        _extra: dict = {
            "path_prefix": spec.effective_path,
            "container_port": spec.port,
            # `name` has no dedicated column (see store.py) — persisted here so
            # list_apps() can show the human-readable name instead of falling
            # back to app_id on every listing.
            "name": spec.name,
            "project": spec.effective_project,
        }
        if "postgres" in _provision_results:
            _extra["db_url"] = _provision_results["postgres"]["db_url"]
        if "dynamodb" in _provision_results:
            _extra["ddb_table_prefix"] = _provision_results["dynamodb"]["table_prefix"]
        if spec.description:
            _extra["description"] = spec.description
        if spec.owner:
            _extra["owner"] = spec.owner
        if spec.creator_contact:
            _extra["creator_contact"] = spec.creator_contact
        if spec.icon_url:
            _extra["icon_url"] = spec.icon_url
        if spec.screenshot_url:
            _extra["screenshot_url"] = spec.screenshot_url
        if spec.service_role:
            _extra["service_role"] = spec.service_role
        if spec.allowed_emails:
            # Read back on every control-plane restart (see the lifespan route-restore
            # handler in service.py) -- app-locations/*.conf is regenerated from scratch
            # on every bootstrap (bootstrap-sandbox.sh wipes it), so this stored copy in
            # `extra` is the only durable record of a per-app allowlist.
            _extra["allowed_emails"] = spec.allowed_emails
        if deployed_by:
            # First-deploy-wins: a teammate redeploying/syncing an app they
            # didn't originally create must never silently reassign it to
            # themselves — only set this when the app has no owner recorded
            # yet (a brand-new app, or one deployed before this field existed).
            _existing = await self._store.get(spec.id)
            _existing_extra = json.loads(_existing["extra"]) if _existing and _existing.get("extra") else {}
            if not _existing_extra.get("deployed_by"):
                _extra["deployed_by"] = deployed_by
        _bg_upsert(
            self._store,
            deployment_id,
            spec.id,
            DeploymentStatus.RUNNING,
            port=port,
            container_id=container_id,
            url=url,
            extra=_extra,
        )
        if app_dir is not None:
            # readiness.py (deploy-time `claude -p` scoring against the app's source) was
            # dropped 2026-09-20 when this engine was vendored out of the standalone
            # deploykit repo into pacmanager -- it ran unsandboxed against live repo
            # content (a real trust-boundary caveat its own spec doc already called out)
            # and duplicated quality gating pacmanager/pracman's own authoring +
            # SpecGuard pipeline already does. Import guarded, not just removed outright,
            # in case a caller of this vendored copy chooses to add an equivalent back.
            try:
                from ..readiness import schedule_readiness_scan
            except ImportError:
                pass
            else:
                schedule_readiness_scan(spec.id, spec.name, spec.description, spec.owner, app_dir)

        yield ev(f"Deployment complete: {spec.id}", "progress")

    async def sync(
        self,
        app_id: str,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        return self._sync_stream(app_id, deployment_id, deployed_by)

    async def _sync_stream(
        self,
        app_id: str,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        ev = lambda msg, level="info": _event(deployment_id, msg, level)

        container_name = _container_name(app_id)
        container_id = await self._container_id(app_id)
        if not container_id:
            raise RuntimeError(
                f"No existing container for {app_id} — run a Full Rebuild first to create one."
            )

        labels = await self._container_labels(container_id)
        if labels.get(SYNC_CAPABLE_LABEL) != "true":
            raise RuntimeError(
                f"Container for {app_id} predates sync support — run a Full Rebuild once "
                "to enable fast sync."
            )

        health_endpoint = labels.get(HEALTH_ENDPOINT_LABEL, "/health")
        container_port = int(labels.get(CONTAINER_PORT_LABEL, "3000"))

        _bg_upsert(self._store, deployment_id, app_id, DeploymentStatus.STARTING)
        yield ev(f"Restarting {container_name} to apply synced code...")
        await _run(["docker", "restart", container_name], timeout=RESTART_TIMEOUT)

        if _DOCKER_NETWORK:
            check_host = await self._get_container_ip_by_id(container_id, _DOCKER_NETWORK) or "127.0.0.1"
            check_port = container_port
        else:
            record = await self._store.get(app_id)
            check_host = "127.0.0.1"
            check_port = record["port"] if record else container_port

        yield ev(f"Waiting for http://{check_host}:{check_port}{health_endpoint}...")
        # sync() only ever targets sync-capable containers, which rebuild at
        # container start (npm install/build) — always use the generous timeout.
        healthy, crash_reason = await self._wait_healthy_or_crash(
            container_id, check_host, check_port, health_endpoint, timeout=SYNC_CAPABLE_HEALTH_CHECK_TIMEOUT
        )
        if not healthy:
            _, logs, logs_err = await _run(["docker", "logs", "--tail", "60", container_id], check=False)
            reason = crash_reason or "health check timed out"
            yield ev(f"Sync restart failed: {reason}", "error")
            log_output = (logs or "").strip()
            if log_output:
                yield ev("── container logs ──", "warn")
                for line in log_output.splitlines()[-60:]:
                    yield ev(line, "error")
                yield ev("── end of logs ──", "warn")
            elif logs_err and "logging driver does not support reading" in logs_err:
                yield ev("── container logs unavailable (daemon logging driver is write-only) ──", "warn")
            _bg_upsert(self._store, deployment_id, app_id, DeploymentStatus.FAILED, error=reason)
            return

        _sync_extra = None
        if deployed_by:
            # Backfill only — same first-deploy-wins rule as deploy(). This
            # only ever fires for apps that predate this field; a normal
            # sync of an already-attributed app leaves extra untouched.
            _existing = await self._store.get(app_id)
            _existing_extra = json.loads(_existing["extra"]) if _existing and _existing.get("extra") else {}
            if not _existing_extra.get("deployed_by"):
                _sync_extra = {"deployed_by": deployed_by}
        _bg_upsert(self._store, deployment_id, app_id, DeploymentStatus.RUNNING, extra=_sync_extra)
        yield ev(f"Sync complete: {app_id}", "progress")

    async def undeploy(self, app_id: str, remove_volumes: bool = True) -> DeploymentResult:
        deployment_id = str(uuid.uuid4())
        container_id = await self._container_id(app_id)
        if container_id:
            await _run(["docker", "stop", container_id], check=False)
            await _run(["docker", "rm", container_id], check=False)
        if remove_volumes:
            await _run(["docker", "volume", "rm", f"{CONTAINER_PREFIX}-{app_id}-data"], check=False)
            await _run(["docker", "volume", "rm", _node_modules_volume(app_id)], check=False)
            await _run(["docker", "volume", "rm", _sync_state_volume(app_id)], check=False)

        await self._nginx.remove_route(app_id)
        await self._ports.release(app_id)

        # Deprovision any datastores that were provisioned for this app.
        # Each is independent — a Postgres deprovision failure must not skip
        # the DynamoDB teardown (or vice versa).
        import logging as _logging
        _ud_log = _logging.getLogger(__name__)
        record = await self._store.get(app_id)
        if record:
            extra = json.loads(record.get("extra") or "{}")
            if extra.get("db_url"):
                try:
                    from ..postgres import deprovision_db as _pg_deprovision
                    await _pg_deprovision(app_id)
                except Exception as _exc:
                    _ud_log.warning("deprovision-db failed for %s: %s", app_id, _exc)
            if extra.get("ddb_table_prefix"):
                try:
                    from ..dynamodb import deprovision_store
                    await deprovision_store(app_id)
                except Exception as _exc:
                    _ud_log.warning("deprovision-store failed for %s: %s", app_id, _exc)

        await self._store.upsert(deployment_id, app_id, DeploymentStatus.REMOVED)
        return DeploymentResult(
            deployment_id=deployment_id,
            app_id=app_id,
            status=DeploymentStatus.REMOVED,
        )

    async def stop(self, app_id: str) -> DeploymentResult:
        deployment_id = str(uuid.uuid4())
        container_id = await self._container_id(app_id)
        if container_id:
            await _run(["docker", "stop", container_id])
        await self._store.upsert(deployment_id, app_id, DeploymentStatus.STOPPED)
        return DeploymentResult(
            deployment_id=deployment_id,
            app_id=app_id,
            status=DeploymentStatus.STOPPED,
        )

    async def start(self, app_id: str) -> DeploymentResult:
        deployment_id = str(uuid.uuid4())
        container_id = await self._container_id(app_id)
        if container_id:
            await _run(["docker", "start", container_id])
        await self._store.upsert(deployment_id, app_id, DeploymentStatus.RUNNING)
        return DeploymentResult(
            deployment_id=deployment_id,
            app_id=app_id,
            status=DeploymentStatus.RUNNING,
        )

    async def status(self, app_id: str) -> DeploymentResult:
        record = await self._store.get(app_id)
        if not record:
            return DeploymentResult(
                deployment_id="",
                app_id=app_id,
                status=DeploymentStatus.REMOVED,
            )
        container_status = await self._container_status(app_id)
        if container_status == "running" and record["status"] != DeploymentStatus.RUNNING:
            await self._store.upsert(record["deployment_id"], app_id, DeploymentStatus.RUNNING)
        return DeploymentResult(**record)

    async def list_apps(self) -> list[AppSummary]:
        import json as _json
        records = await self._store.list_all()
        summaries = []
        for r in records:
            extra = _json.loads(r.get("extra") or "{}")
            # `name` has no dedicated column in the `deployments` table — it is
            # persisted into `extra` at deploy time (see docker.py's _extra
            # dict above); r.get("name", ...) always missed since the row dict
            # never has that key, so every card silently showed app_id instead.
            summaries.append(AppSummary(
                app_id=r["app_id"],
                name=extra.get("name") or r["app_id"],
                status=r["status"],
                url=r.get("url"),
                port=r.get("port"),
                deployed_at=r.get("created_at"),
                description=extra.get("description"),
                deployed_by=extra.get("deployed_by"),
                owner=extra.get("owner"),
                creator_contact=extra.get("creator_contact"),
                screenshot_url=extra.get("screenshot_url"),
                icon_url=extra.get("icon_url"),
                project=extra.get("project"),
                service_role=extra.get("service_role"),
            ))
        return summaries

    async def get_logs(self, app_id: str, tail: int = 100) -> str:
        container_id = await self._container_id(app_id)
        if not container_id:
            return f"No container found for {app_id}"
        _, out, err = await _run(
            ["docker", "logs", "--tail", str(tail), container_id],
            check=False,
        )
        combined = (out + "\n" + err).strip()
        if not combined and err and "logging driver does not support reading" in err:
            return (
                f"[deploykit] Logs unavailable — the Docker daemon on the sandbox uses a logging driver "
                f"that does not support reading ({err.strip()}). "
                f"New containers started by deploykit will use json-file logging. "
                f"Redeploy the app to get a log-readable container."
            )
        return combined

    async def health_check(self) -> dict:
        rc, out, _ = await _run(["docker", "info", "--format", "{{.ServerVersion}}"], check=False)
        return {"docker": "ok" if rc == 0 else "unreachable", "version": out}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _container_id(self, app_id: str) -> str | None:
        rc, out, _ = await _run(
            ["docker", "inspect", "--format", "{{.ID}}", _container_name(app_id)],
            check=False,
        )
        cid = out.strip().splitlines()[0].strip() if out.strip() else ""
        return cid if (rc == 0 and cid) else None

    async def _container_labels(self, container_id: str) -> dict[str, str]:
        rc, out, _ = await _run(
            ["docker", "inspect", "--format", "{{json .Config.Labels}}", container_id],
            check=False,
        )
        if rc != 0 or not out.strip():
            return {}
        try:
            return json.loads(out.strip()) or {}
        except ValueError:
            return {}

    async def _container_status(self, app_id: str) -> str:
        rc, out, _ = await _run(
            ["docker", "inspect", "--format", "{{.State.Status}}", _container_name(app_id)],
            check=False,
        )
        return out.strip() if rc == 0 else "absent"

    async def _get_container_ip(self, app_id: str, network: str) -> str | None:
        # Use index template form so network names with hyphens (e.g. "deploykit-net") work
        fmt = f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}'
        rc, out, _ = await _run(
            ["docker", "inspect", "--format", fmt, _container_name(app_id)],
            check=False,
        )
        return out.strip() or None

    async def _get_container_ip_by_id(self, container_id: str, network: str) -> str | None:
        # Use index template form so network names with hyphens (e.g. "deploykit-net") work
        fmt = f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}'
        rc, out, _ = await _run(
            ["docker", "inspect", "--format", fmt, container_id],
            check=False,
        )
        return out.strip() or None

    async def _wait_healthy_or_crash(
        self,
        container_id: str,
        host: str,
        port: int,
        endpoint: str,
        timeout: int = 60,
    ) -> tuple[bool, str | None]:
        """Poll the health endpoint; return early if the container exits."""
        import httpx

        url = f"http://{host}:{port}{endpoint}"
        deadline = time.time() + timeout
        async with httpx.AsyncClient() as client:
            while time.time() < deadline:
                # Detect container crash before waiting for the full timeout
                _, status_out, _ = await _run(
                    ["docker", "inspect", "--format",
                     "{{.State.Status}}:{{.State.ExitCode}}", container_id],
                    check=False,
                )
                info = status_out.strip()
                if ":" in info:
                    status, exit_code = info.split(":", 1)
                    if status in ("exited", "dead"):
                        return False, f"container exited (code {exit_code})"

                try:
                    r = await client.get(url, timeout=3.0)
                    if r.status_code < 500:
                        return True, None
                except Exception:
                    pass
                await asyncio.sleep(2)
        return False, f"health check timed out after {timeout}s"
