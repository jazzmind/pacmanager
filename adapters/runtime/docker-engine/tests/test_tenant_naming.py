"""Tenant-safe naming, the gated nginx template, and the engine's internal auth endpoint."""
import importlib

import httpx
import pytest

from deploykit import naming


def test_prefix_flows_into_every_shared_name():
    assert naming.container_name("a-b") == "pac-a-b"
    assert naming.image_tag("a-b") == "pac/a-b:latest"          # not deploykit/<id>
    assert naming.conf_name("a-b") == "pac-a-b.conf"
    assert naming.app_id_from_conf("pac-a-b") == "a-b"
    assert naming.pg_ident("a-b") == "pac_a_b"                   # db AND role, never the bare slug


def test_pg_idents_stay_distinct_past_the_63_char_limit():
    a, b = "x" * 60 + "-one", "x" * 60 + "-two"
    ia, ib = naming.pg_ident(a), naming.pg_ident(b)
    assert len(ia) <= 63 and len(ib) <= 63 and ia != ib


def test_ddb_prefix_cannot_overlap_between_foo_and_foo_bar():
    assert naming.ddb_table_prefix("foo") == "pac.foo."
    assert not naming.ddb_table_prefix("foo-bar").startswith(naming.ddb_table_prefix("foo"))
    with pytest.raises(ValueError):
        naming.ddb_table_prefix("a.b")


def test_prefix_is_validated(monkeypatch):
    monkeypatch.setenv("DEPLOYKIT_RESOURCE_PREFIX", "Bad Prefix!")
    with pytest.raises(ValueError):
        importlib.reload(naming)
    monkeypatch.delenv("DEPLOYKIT_RESOURCE_PREFIX")
    importlib.reload(naming)


def _proxy(monkeypatch, mode):
    from deploykit.proxy import nginx
    monkeypatch.setattr(nginx, "_NGINX_AUTH", mode)
    monkeypatch.setattr(nginx, "_DEPLOYKIT_DOCKER_NETWORK", "net")
    return nginx.NginxProxy()


def test_gated_block_authenticates_overwrites_identity_and_strips_the_session_cookie(monkeypatch, tmp_path):
    block = _proxy(monkeypatch, "deploykit").generate_location_block("my-app", "/pac-my-app", 3000, container_port=3000,
                                                                   allowed_emails=["a@example.com"])
    assert "auth_request /_pac_auth/my-app;" in block
    assert "location = /_pac_auth/my-app" in block and "internal;" in block
    assert "/internal/auth/my-app" in block
    assert "proxy_set_header X-Deploykit-Email $pac_email;" in block
    assert "proxy_set_header Cookie $dk_cookie_clean;" in block
    assert "error_page 401 = @dk_login;" in block
    assert 'set $backend "pac-my-app:3000";' in block
    assert "x_forwarded_email" not in block                      # the spoofable header is not consulted


def test_ungated_block_keeps_the_local_behaviour(monkeypatch):
    block = _proxy(monkeypatch, "none").generate_location_block("my-app", "/my-app", 3000, container_port=3000)
    assert "auth_request" not in block and 'set $backend "pac-my-app:3000";' in block


def test_gating_needs_docker_network_mode(monkeypatch):
    from deploykit.proxy import nginx
    monkeypatch.setattr(nginx, "_NGINX_AUTH", "deploykit")
    monkeypatch.setattr(nginx, "_DEPLOYKIT_DOCKER_NETWORK", "")
    with pytest.raises(ValueError):
        nginx.NginxProxy().generate_location_block("a", "/a", 1)


@pytest.fixture
def engine(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("DEPLOYKIT_TOKEN", "t")
    monkeypatch.setenv("DEPLOYKIT_DB", str(tmp_path / "s.db"))
    monkeypatch.setenv("DEPLOYKIT_PORT_STATE", str(tmp_path / "p.json"))
    monkeypatch.setenv("NGINX_CONFIG_DIR", str(tmp_path / "n"))
    import deploykit.store as store_mod
    import deploykit.service as service
    importlib.reload(store_mod); importlib.reload(service)
    with TestClient(service.create_app(), raise_server_exceptions=False) as c:
        yield c, service


def _fake_session(monkeypatch, status, email=""):
    class _R:
        status_code = status
        headers = {"x-deploykit-email": email}
    class _C:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, headers=None): return _R()
    monkeypatch.setattr(httpx, "AsyncClient", _C)


def test_internal_auth_is_401_when_deploykit_says_anonymous(engine, monkeypatch):
    c, _ = engine
    _fake_session(monkeypatch, 401)
    assert c.get("/internal/auth/app1").status_code == 401


def test_internal_auth_fails_closed_for_an_app_this_engine_does_not_know(engine, monkeypatch):
    c, _ = engine
    _fake_session(monkeypatch, 200, "a@example.com")
    assert c.get("/internal/auth/ghost").status_code == 403


def test_internal_auth_is_503_when_deploykit_is_unreachable(engine, monkeypatch):
    c, _ = engine
    class _Boom:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): raise httpx.ConnectError("down")
        async def __aexit__(self, *a): pass
    monkeypatch.setattr(httpx, "AsyncClient", _Boom)
    assert c.get("/internal/auth/app1").status_code == 503
