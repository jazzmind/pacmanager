"""Regression tests for the local-mode bugs found while getting deploykit running on a
laptop with no sandbox VM (see pacmanager's docs/implementation-status.md R4):

1. add_route()/remove_route() only caught RuntimeError, but a missing `nginx` binary
   raises FileNotFoundError from asyncio.create_subprocess_exec — so with no nginx on
   PATH, a deploy's container would build, run and pass health checks while the deploy
   still reported an unhandled-exception failure and the store row was stranded.
2. _reload() tried `systemctl` first; on macOS that also raises FileNotFoundError
   *before* ever reaching the `nginx -s reload` fallback on the next line.

Both are fixed by normalizing a missing binary in `_run()`: check=True raises the same
RuntimeError every existing call site already expects; check=False returns an rc=127
result so the caller's own fallback logic actually runs instead of the exception escaping
past it.
"""
import subprocess
import sys

import pytest

from deploykit.proxy import nginx as nginx_module
from deploykit.proxy.nginx import NginxProxy, _run


@pytest.mark.asyncio
async def test_run_raises_runtime_error_for_a_missing_binary_when_check_true():
    with pytest.raises(RuntimeError, match="command not found"):
        await _run(["definitely-not-a-real-binary-xyz"], check=True)


@pytest.mark.asyncio
async def test_run_returns_rc_127_for_a_missing_binary_when_check_false():
    rc, out, err = await _run(["definitely-not-a-real-binary-xyz"], check=False)
    assert rc == 127
    assert out == ""
    assert "command not found" in err


@pytest.mark.asyncio
async def test_run_still_raises_on_a_real_nonzero_exit_when_check_true():
    with pytest.raises(RuntimeError):
        await _run([sys.executable, "-c", "import sys; sys.exit(1)"], check=True)


@pytest.mark.asyncio
async def test_run_still_succeeds_on_a_real_command():
    rc, out, _ = await _run([sys.executable, "-c", "print('hi')"], check=True)
    assert rc == 0
    assert out == "hi"


@pytest.mark.asyncio
async def test_reload_falls_back_to_nginx_when_systemctl_is_missing(monkeypatch, tmp_path):
    # Simulate macOS: no systemctl, but a fake "nginx" binary is on PATH so the fallback
    # branch actually runs and we can observe it, rather than failing for an unrelated
    # reason (no real nginx installed in this environment either).
    fake_nginx = tmp_path / "nginx"
    fake_nginx.write_text("#!/bin/sh\nexit 0\n")
    fake_nginx.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(nginx_module, "_NGINX_CONTAINER_NAME", "")
    proxy = NginxProxy(config_dir=tmp_path / "conf")
    await proxy._reload()  # must not raise — systemctl missing, falls through to nginx -s reload


@pytest.mark.asyncio
async def test_add_route_rolls_back_cleanly_when_nginx_itself_is_entirely_missing(monkeypatch, tmp_path):
    # The container built, ran and passed health checks (not modeled here — this is only
    # the nginx layer); the bug was that add_route's own exception handling never ran
    # because FileNotFoundError isn't a RuntimeError. Confirm it now raises the *same*
    # exception type every other caller already handles.
    monkeypatch.setenv("PATH", str(tmp_path))  # empty PATH dir: no nginx, no systemctl, nothing
    monkeypatch.setattr(nginx_module, "_NGINX_CONTAINER_NAME", "")
    proxy = NginxProxy(config_dir=tmp_path / "conf")
    with pytest.raises(RuntimeError):
        await proxy.add_route("demo-app", "/demo-app", 4100)
    # The bad conf file must have been rolled back, not left stranded.
    assert not (tmp_path / "conf" / "demo-app.conf").exists()


"""Per-app access control (AppSpec.allowed_emails, see pacmanager's docs/implementation-status.md
Part 3): a plain incoming-header check against $http_x_forwarded_email, not nginx's auth_request
module -- oauth2-proxy runs as the actual reverse proxy in front of nginx (not a subrequest
target; see the module docstring on nginx.py and the commit history for why auth_request itself
doesn't work in this nginx/Docker combination), so X-Forwarded-Email already arrives as a normal
header on every location.
"""
from deploykit.proxy.nginx import _acl_block


def test_acl_block_is_empty_when_no_emails_are_given():
    assert _acl_block(None) == ""
    assert _acl_block([]) == ""


def test_acl_block_uses_error_page_as_a_sibling_of_if_not_nested_inside_it():
    # error_page inside nginx's `if` is silently ignored (verified live: the response fell
    # through to nginx's bare default 403 page instead of the branded /unauthorized one).
    block = _acl_block(["alice@example.com"])
    lines = [l.strip() for l in block.strip().splitlines()]
    assert lines[0].startswith("error_page 403 =403 /unauthorized;")
    assert lines[1].startswith("if (")


def test_acl_block_preserves_the_403_status_code():
    # "=403" (no space), not a bare "=" -- a bare "=" takes on whatever /unauthorized itself
    # returns, which is 200 for an existing file, silently losing the 403 semantics.
    assert "=403 /unauthorized" in _acl_block(["alice@example.com"])


def test_acl_block_escapes_regex_metacharacters_in_email_addresses():
    # Unescaped "." and "+" are regex metacharacters -- "a.b@x.com" would also match
    # "axb@x.com" without this, and "+" has no special meaning to escape away either but
    # must survive re.escape without corrupting the address.
    block = _acl_block(["a.b+tag@example.com"])
    assert r"a\.b\+tag@example\.com" in block


def test_acl_block_lowercases_and_joins_multiple_emails_with_alternation():
    block = _acl_block(["Alice@Example.com", "bob@example.com"])
    assert r"alice@example\.com|bob@example\.com" in block


def test_acl_block_rejects_a_malformed_email_rather_than_interpolating_it_unsafely():
    import pytest
    with pytest.raises(ValueError, match="allowed_emails"):
        _acl_block(["not-an-email; also nginx injection attempt {"])


@pytest.mark.asyncio
async def test_generate_location_block_with_an_acl_produces_syntactically_valid_nginx(tmp_path):
    # The real, load-bearing check: nginx -t against the actual generated block. If nginx
    # isn't available in this environment, skip rather than fail for an unrelated reason.
    proxy = NginxProxy(config_dir=tmp_path / "conf")
    block = proxy.generate_location_block("demo-app", "/demo-app", 4100, allowed_emails=["alice@example.com"])
    assert "if ($http_x_forwarded_email" in block
    conf_dir = tmp_path / "conf.d"
    conf_dir.mkdir()
    (conf_dir / "demo-app.conf").write_text(block)
    (conf_dir / "default.conf").write_text(
        "server { listen 8199; location / { return 200; } include " + str(conf_dir / "demo-app.conf") + "; }"
    )
    rc, _, err = await _run(["nginx", "-t", "-c", str(conf_dir / "default.conf")], check=False)
    if rc == 127:
        pytest.skip("nginx binary not available in this test environment")
    assert rc == 0, err
