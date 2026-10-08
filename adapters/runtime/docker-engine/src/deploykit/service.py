"""
FastAPI service — deploykit lifecycle API.

Endpoints:
  POST   /api/v1/deploy          deploy an app (SSE stream)
  POST   /api/v1/sync/{app_id}   fast sync — restart a sync-capable container in place (SSE stream)
  POST   /api/v1/undeploy        remove an app
  POST   /api/v1/stop/{app_id}   stop without removing
  POST   /api/v1/start/{app_id}  start a stopped app
  GET    /api/v1/status/{app_id} current status
  GET    /api/v1/apps            list all apps
  GET    /api/v1/logs/{app_id}   recent logs
  GET    /api/v1/stream/{deployment_id}   SSE stream for a deployment
  GET    /health                 unauthenticated liveness
  GET    /health/ready           readiness (backend reachable)

Compatible with the busibox deploy-api API surface so printing-press can wrap
either service against its /openapi.json.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

_log = logging.getLogger(__name__)

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sse_starlette.sse import EventSourceResponse

from pydantic import BaseModel as _BodyBaseModel

from .auth.base import AuthError, AuthProvider
from .auth.shared_token import SharedTokenAuthProvider
from .backends.base import DeployBackend
from .backends.docker import DockerBackend
from .models import (
    AppSummary,
    DeployRequest,
    DeploymentResult,
    DeploymentStatus,
    Principal,
    UndeployRequest,
)
from .ports import PortAllocator
from .proxy.nginx import NginxProxy
from .store import DeploymentStore


class _ProvisionRequest(_BodyBaseModel):
    app_id: str
    enable_pgvector: bool = False


class _ProvisionStoreRequest(_BodyBaseModel):
    app_id: str
    kind: Literal["postgres", "dynamodb"]
    enable_pgvector: bool = False


class _AccessRequest(_BodyBaseModel):
    allowed_emails: list[str] = []

# In-memory mapping of deployment_id → async queue for SSE fan-out
_STREAMS: dict[str, asyncio.Queue] = {}


def create_app(
    backend: DeployBackend | None = None,
    auth: AuthProvider | None = None,
) -> FastAPI:
    """
    Factory — wire up dependencies.

    busibox/deploy-api can call this with its own backend/auth implementations.
    Standalone deploykit uses the defaults (DockerBackend + SharedTokenAuthProvider).
    """
    store = DeploymentStore()
    ports = PortAllocator()
    nginx = NginxProxy()

    _backend = backend or DockerBackend(store=store, ports=ports, nginx=nginx)
    _auth = auth or SharedTokenAuthProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Re-register nginx routes for running apps after container restart
        try:
            import json as _json
            all_records = await store.list_all()
            for rec in all_records:
                if rec.get("status") == "running" and rec.get("port"):
                    extra = _json.loads(rec.get("extra") or "{}")
                    app_id = rec["app_id"]
                    path_prefix = extra.get("path_prefix") or f"/{app_id}"
                    backend_port: int = rec["port"]
                    # Older deployment records predate the container_port field in
                    # `extra` — fall back to backend_port, which deploy() always sets
                    # equal to container_port for local-source apps (see docker.py's
                    # add_route call). Without this fallback, reconciliation silently
                    # regenerates a host-network (127.0.0.1) route for apps that are
                    # actually only reachable via Docker DNS, breaking them on every
                    # deploykit control-plane restart.
                    container_port: int | None = extra.get("container_port") or backend_port
                    # allowed_emails must round-trip through restart too, or a per-app
                    # ACL silently disappears every time the control plane restarts
                    # (app-locations/*.conf is regenerated from scratch here, and
                    # bootstrap-sandbox.sh wipes it on every bootstrap) -- `extra` is
                    # the only durable copy (see docker.py's _deploy_stream).
                    allowed_emails = extra.get("allowed_emails") or None
                    await nginx.add_route(
                        app_id=app_id,
                        path_prefix=path_prefix,
                        backend_port=backend_port,
                        container_port=container_port,
                        allowed_emails=allowed_emails,
                    )
                    _log.info("Restored nginx route: %s → %s", app_id, path_prefix)
        except Exception as _exc:
            _log.warning("Route restore on startup failed: %s", _exc)
        yield

    app = FastAPI(
        title="deploykit",
        description="Sandboxed app deployment — Docker backend, nginx routing.",
        version="0.1.0",
        lifespan=lifespan,
        # Disabled: /docs, /redoc and /openapi.json were reachable with no auth
        # dependency at all (FastAPI wires them up regardless of any other
        # route's Depends), handing out the full API surface map to anyone who
        # could reach nginx — including, before this pass, through the
        # /api/deploykit/ prefix's auth_request-off exemption.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.environ.get("DEPLOYKIT_CORS_ORIGINS", "http://localhost").split(","),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------
    # Auth dependency
    # ------------------------------------------------------------------

    async def require_auth(request: Request) -> Principal:
        try:
            return await _auth.authenticate(request)
        except AuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc))

    # ------------------------------------------------------------------
    # Health (unauthenticated)
    # ------------------------------------------------------------------

    @app.get("/health", tags=["health"])
    async def liveness():
        return {"status": "ok"}

    # ------------------------------------------------------------------
    # nginx auth_request target (PAC_NGINX_AUTH=deploykit) -- unauthenticated by design
    # ------------------------------------------------------------------

    @app.get("/internal/auth/{app_id}", include_in_schema=False)
    async def internal_auth(app_id: str, request: Request):
        """Who may open this app? 401 = not signed in, 403 = signed in but not on the app's list,
        200 (+ X-Deploykit-Email) = serve. Sign-in itself belongs to deploykit: we forward the
        visitor's cookie to its /auth/session and apply the app's allowed_emails (the same list
        pacmanager sets through PUT /api/v1/access/<id>). Fails closed on any error. Called only by
        nginx's internal auth_request location, never exposed on a public route."""
        import httpx as _httpx
        import json as _json
        from .naming import RESOURCE_PREFIX  # noqa: F401  (documents the namespace this serves)

        url = os.environ.get("PAC_SESSION_CHECK_URL", "http://deploykit:8011/auth/session")
        try:
            async with _httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(url, headers={"Cookie": request.headers.get("cookie", "")})
        except _httpx.HTTPError as exc:
            _log.warning("session check against %s failed: %s", url, exc)
            return Response(status_code=503)
        if r.status_code == 401:
            return Response(status_code=401)
        email = (r.headers.get("x-deploykit-email") or "").strip().lower()
        if r.status_code != 200 or not email:
            return Response(status_code=401 if r.status_code in (200, 401) else 503)
        record = await store.get(app_id)
        if record is None:
            return Response(status_code=403)  # fail closed: not an app this engine knows
        extra = _json.loads(record.get("extra") or "{}")
        allowed = [e.lower() for e in (extra.get("allowed_emails") or [])]
        if allowed and email not in allowed:
            return Response(status_code=403)
        resp = Response(status_code=200)
        resp.headers["X-Deploykit-Email"] = email
        return resp

    @app.get("/health/ready", tags=["health"])
    async def readiness(principal: Principal = Depends(require_auth)):
        info = await _backend.health_check()
        if info.get("docker") != "ok":
            raise HTTPException(503, detail=info)
        return {"status": "ready", **info}

    # ------------------------------------------------------------------
    # Public status summary (unauthenticated — same data as landing page)
    # ------------------------------------------------------------------

    @app.get("/api/v1/status-public", include_in_schema=False, response_model=list[AppSummary])
    async def status_public(principal: Principal = Depends(require_auth)):
        return await _backend.list_apps()

    # ------------------------------------------------------------------
    # Deploy (SSE stream)
    # ------------------------------------------------------------------

    def _launch_stream(deployment_id: str, agen_factory) -> None:
        """Run an async-generator-yielding coroutine, fanning events into the SSE
        queue and the durable store. Shared by /deploy and /sync."""
        queue: asyncio.Queue = asyncio.Queue()
        _STREAMS[deployment_id] = queue

        async def _run_and_enqueue():
            from .models import DeploymentEvent as _DE

            _store_tasks: list[asyncio.Task] = []

            def _store_event_nowait(evt: "_DE") -> None:
                """Fire-and-forget store write — never blocks the SSE queue."""
                async def _do():
                    try:
                        await store.append_event(
                            deployment_id, evt.ts, evt.level, evt.message
                        )
                    except Exception:
                        _log.warning("Failed to persist event for %s", deployment_id, exc_info=True)
                _store_tasks.append(asyncio.create_task(_do()))

            _log.info("Task %s started", deployment_id)
            try:
                async for event in await agen_factory():
                    await queue.put({"data": event.model_dump_json(), "event": "log"})
                    _store_event_nowait(event)
            except Exception as exc:
                _log.exception("Task %s failed", deployment_id)
                err_event = _DE(deployment_id=deployment_id, level="error", message=str(exc))
                await queue.put({"data": err_event.model_dump_json(), "event": "log"})
                _store_event_nowait(err_event)
            finally:
                _log.info("Task %s finished", deployment_id)
                # Flush all pending store writes before closing the stream so the
                # replay path sees the final event (e.g. progress) if clients connect late
                if _store_tasks:
                    await asyncio.gather(*_store_tasks, return_exceptions=True)
                await queue.put(None)  # sentinel

        asyncio.create_task(_run_and_enqueue())

    @app.post("/api/v1/deploy", tags=["deployment"])
    async def deploy(req: DeployRequest, principal: Principal = Depends(require_auth)):
        deployment_id = str(uuid.uuid4())
        _launch_stream(deployment_id, lambda: _backend.deploy(req.spec, deployment_id, principal.user_id))
        return JSONResponse(
            {"deployment_id": deployment_id, "app_id": req.spec.id},
            status_code=202,
        )

    @app.post("/api/v1/sync/{app_id}", tags=["deployment"])
    async def sync(app_id: str, principal: Principal = Depends(require_auth)):
        deployment_id = str(uuid.uuid4())
        _launch_stream(deployment_id, lambda: _backend.sync(app_id, deployment_id, principal.user_id))
        return JSONResponse(
            {"deployment_id": deployment_id, "app_id": app_id},
            status_code=202,
        )

    # ------------------------------------------------------------------
    # SSE stream endpoint
    # ------------------------------------------------------------------

    @app.get("/api/v1/stream/{deployment_id}", tags=["deployment"])
    async def stream(deployment_id: str, principal: Principal = Depends(require_auth)):
        async def _generate() -> AsyncIterator[dict]:
            queue = _STREAMS.get(deployment_id)
            if queue is None:
                # Replay from store — emit JSON matching the live event shape so
                # the client parses replayed events identically to live ones.
                import json as _json

                events = await store.get_events(deployment_id)
                for e in events:
                    payload = _json.dumps(
                        {
                            "deployment_id": deployment_id,
                            "level": e.get("level", "info"),
                            "message": e.get("message", ""),
                            "ts": e.get("ts"),
                        }
                    )
                    yield {"data": payload, "event": "log"}
                return

            while True:
                item = await queue.get()
                if item is None:
                    _STREAMS.pop(deployment_id, None)
                    break
                yield item

        return EventSourceResponse(_generate())

    # ------------------------------------------------------------------
    # Lifecycle operations
    # ------------------------------------------------------------------

    @app.post("/api/v1/undeploy", tags=["deployment"], response_model=DeploymentResult)
    async def undeploy(req: UndeployRequest, principal: Principal = Depends(require_auth)):
        return await _backend.undeploy(req.app_id, req.remove_volumes)

    @app.post("/api/v1/stop/{app_id}", tags=["deployment"], response_model=DeploymentResult)
    async def stop(app_id: str, principal: Principal = Depends(require_auth)):
        return await _backend.stop(app_id)

    @app.post("/api/v1/start/{app_id}", tags=["deployment"], response_model=DeploymentResult)
    async def start(app_id: str, principal: Principal = Depends(require_auth)):
        return await _backend.start(app_id)

    @app.get("/api/v1/status/{app_id}", tags=["deployment"], response_model=DeploymentResult)
    async def status(app_id: str, principal: Principal = Depends(require_auth)):
        return await _backend.status(app_id)

    @app.get("/api/v1/apps", tags=["deployment"], response_model=list[AppSummary])
    async def list_apps(principal: Principal = Depends(require_auth)):
        return await _backend.list_apps()

    @app.get("/api/v1/logs/{app_id}", tags=["deployment"])
    async def logs(app_id: str, tail: int = 100, principal: Principal = Depends(require_auth)):
        return {"app_id": app_id, "logs": await _backend.get_logs(app_id, tail)}

    # ------------------------------------------------------------------
    # Postgres provisioning
    # ------------------------------------------------------------------

    @app.post("/api/v1/provision-db", tags=["database"])
    async def provision_db_endpoint(
        req: _ProvisionRequest,
        principal: Principal = Depends(require_auth),
    ):
        from .postgres import provision_db as _pg_provision
        try:
            result = await _pg_provision(req.app_id, enable_pgvector=req.enable_pgvector)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"DB provisioning failed: {exc}") from exc
        return {"app_id": req.app_id, **result}

    @app.delete("/api/v1/provision-db/{app_id}", tags=["database"])
    async def deprovision_db_endpoint(
        app_id: str,
        principal: Principal = Depends(require_auth),
    ):
        from .postgres import deprovision_db as _pg_deprovision
        try:
            await _pg_deprovision(app_id)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"DB deprovisioning failed: {exc}") from exc
        return {"app_id": app_id, "status": "deprovisioned"}

    # ------------------------------------------------------------------
    # Generalized datastore provisioning (Postgres or DynamoDB)
    #
    # /api/v1/provision-db above is kept unchanged for backward compatibility
    # (existing VS Code extension builds, scripts, etc. that only know about
    # Postgres). These new endpoints are the single generalized entry point
    # going forward — `kind='postgres'` here delegates to the exact same
    # provision_db()/deprovision_db() functions as the legacy endpoint.
    # ------------------------------------------------------------------

    @app.post("/api/v1/provision-store", tags=["database"])
    async def provision_store_endpoint(
        req: _ProvisionStoreRequest,
        principal: Principal = Depends(require_auth),
    ):
        try:
            if req.kind == "postgres":
                from .postgres import provision_db as _pg_provision
                result = await _pg_provision(req.app_id, enable_pgvector=req.enable_pgvector)
            else:
                from .dynamodb import provision_store as _ddb_provision
                result = await _ddb_provision(req.app_id)
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"{req.kind} provisioning failed: {exc}"
            ) from exc
        return {"app_id": req.app_id, "kind": req.kind, **result}

    @app.put("/api/v1/access/{app_id}", tags=["access"])
    async def set_access_endpoint(
        app_id: str,
        req: _AccessRequest,
        principal: Principal = Depends(require_auth),
    ):
        """Update an app's per-app email allowlist without a full redeploy.

        Regenerates the nginx route immediately (empty list = no restriction beyond
        whatever edge SSO itself requires) and persists it to `extra` so it survives
        a control-plane restart (see the lifespan route-restore handler above).
        """
        record = await store.get(app_id)
        if not record:
            raise HTTPException(status_code=404, detail=f"No deployment found for {app_id}")
        import json as _json
        extra = _json.loads(record.get("extra") or "{}")
        path_prefix = extra.get("path_prefix") or f"/{app_id}"
        backend_port = record.get("port")
        container_port = extra.get("container_port") or backend_port
        if not backend_port:
            raise HTTPException(status_code=409, detail=f"{app_id} has no running port to route to")
        try:
            await nginx.add_route(
                app_id=app_id,
                path_prefix=path_prefix,
                backend_port=backend_port,
                container_port=container_port,
                allowed_emails=req.allowed_emails or None,
            )
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await store.upsert(
            record["deployment_id"], app_id, DeploymentStatus(record["status"]),
            extra={"allowed_emails": req.allowed_emails},
        )
        return {"app_id": app_id, "allowed_emails": req.allowed_emails}

    @app.delete("/api/v1/provision-store/{app_id}", tags=["database"])
    async def deprovision_store_endpoint(
        app_id: str,
        kind: Literal["postgres", "dynamodb"],
        principal: Principal = Depends(require_auth),
    ):
        try:
            if kind == "postgres":
                from .postgres import deprovision_db as _pg_deprovision
                await _pg_deprovision(app_id)
            else:
                from .dynamodb import deprovision_store as _ddb_deprovision
                await _ddb_deprovision(app_id)
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"{kind} deprovisioning failed: {exc}"
            ) from exc
        return {"app_id": app_id, "kind": kind, "status": "deprovisioned"}

    # Skills/templates (backed by skills.py) and the model-catalog/intent-routing/cost
    # endpoints (backed by litellm_client.py) were dropped 2026-09-20 when this engine was
    # vendored out of the standalone deploykit repo into pacmanager -- neither module was
    # carried over (skills.py held PR-branded ARB skills/templates; litellm_client.py
    # duplicated cost-tracking pacmanager's own admin console already does via a direct
    # LiteLLM fetch, see demo/admin.js). pracman's runtime adapter never called any of
    # these routes (confirmed against adapters/runtime/deploykit/lib/client.js's full
    # call list) -- nothing depends on this trim.

    # ------------------------------------------------------------------
    # App registration (scaffold state — no Docker ops)
    # ------------------------------------------------------------------

    class _RegisterRequest(_BodyBaseModel):
        app_id: str
        skill_id: str | None = None
        description: str | None = None

    @app.post("/api/v1/apps/register", tags=["deployment"])
    async def register_app(req: _RegisterRequest, principal: Principal = Depends(require_auth)):
        """Register a scaffolded app in state without deploying it."""
        deployment_id = str(uuid.uuid4())
        await store.upsert(
            deployment_id=deployment_id,
            app_id=req.app_id,
            status="scaffolding",
            extra={"skill_id": req.skill_id, "description": req.description},
        )
        return {"app_id": req.app_id, "status": "scaffolding", "deployment_id": deployment_id}

    return app


def main():
    """Entry point: `deploykit serve`"""
    import uvicorn

    port = int(os.environ.get("DEPLOYKIT_PORT", "8011"))
    host = os.environ.get("DEPLOYKIT_HOST", "127.0.0.1")
    app = create_app()
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
