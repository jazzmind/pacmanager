"""
deploykit CLI — mirrors every MCP tool for direct dev use.

Commands:
  deploykit enroll          One-time SSH key setup
  deploykit tunnel          Open the port-forward tunnel (blocking)
  deploykit serve           Start the deploykit API server on the sandbox
  deploykit deploy          Deploy an app
  deploykit watch           Stream deployment progress
  deploykit apps            List apps
  deploykit status          Status of one app
  deploykit logs            Container logs
  deploykit stop            Stop an app
  deploykit start           Start a stopped app
  deploykit undeploy        Remove an app
  deploykit mcp             Start the MCP server (stdio)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(name="deploykit", help="Sandbox app deployment toolkit.")
console = Console()

_API_URL = os.environ.get("DEPLOYKIT_API_URL", "http://localhost:8011").rstrip("/")
_TOKEN = os.environ.get("DEPLOYKIT_TOKEN", "")
_USER = os.environ.get("DEPLOYKIT_USER", os.environ.get("USERNAME", "unknown"))


def _headers() -> dict:
    return {"Authorization": f"Bearer {_TOKEN}", "X-Deploy-User": _USER}


def _client() -> httpx.Client:
    if not _TOKEN:
        console.print("[red]DEPLOYKIT_TOKEN is not set.[/red] Set it in your environment.")
        raise typer.Exit(1)
    return httpx.Client(base_url=_API_URL, headers=_headers(), timeout=30)


# ------------------------------------------------------------------
# Server
# ------------------------------------------------------------------
# `enroll`/`tunnel` (SSH key enrollment + jump-host tunnel to a remote sandbox
# host) were dropped 2026-09-20 when this engine was vendored out of the
# standalone deploykit repo into pacmanager -- they're specific to the
# frozen remote-shared-sandbox deploy target (see
# deploykit/docs/sandbox.md's freeze notice), not to local/generic Docker
# deploys, and their real infra hostnames had no place in an OSS core.


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", envvar="DEPLOYKIT_HOST", help="Bind address"),
    port: int = typer.Option(8011, envvar="DEPLOYKIT_PORT", help="Port to listen on"),
):
    """Start the deploykit API server (run this on the sandbox)."""
    import uvicorn

    from ..service import create_app

    console.print(f"Starting deploykit API on {host}:{port}")
    uvicorn.run(create_app(), host=host, port=port)


# ------------------------------------------------------------------
# App lifecycle (mirrors MCP tools)
# ------------------------------------------------------------------


@app.command()
def deploy(
    app_id: str = typer.Argument(..., help="Unique app slug"),
    name: str = typer.Option(..., "--name", "-n", help="Human-readable name"),
    image: str = typer.Option(None, help="Docker image to pull"),
    repo_url: str = typer.Option(None, help="Git repo URL to clone and build"),
    repo_branch: str = typer.Option("main", help="Branch to deploy"),
    port: int = typer.Option(3000, help="Port the app listens on"),
    path_prefix: str = typer.Option(None, help="nginx path prefix"),
    env: list[str] = typer.Option([], "--env", "-e", help="Env vars as KEY=VALUE"),
    memory: str = typer.Option("512m", help="Container memory limit"),
    build_cmd: str = typer.Option(None, help="Build command"),
    start_cmd: str = typer.Option(None, help="Start command"),
    watch: bool = typer.Option(True, "--watch/--no-watch", help="Stream logs after submitting"),
):
    """Deploy an app to the sandbox."""
    env_vars = dict(e.split("=", 1) for e in env if "=" in e)
    spec: dict = {"id": app_id, "name": name, "port": port, "memory_limit": memory, "env_vars": env_vars}
    if image:
        spec["image"] = image
    elif repo_url:
        spec["repo_url"] = repo_url
        spec["repo_branch"] = repo_branch
    else:
        console.print("[red]Provide either --image or --repo-url[/red]")
        raise typer.Exit(1)
    if path_prefix:
        spec["path_prefix"] = path_prefix
    if build_cmd:
        spec["build_command"] = build_cmd
    if start_cmd:
        spec["start_command"] = start_cmd

    with _client() as c:
        r = c.post("/api/v1/deploy", json={"spec": spec})
        r.raise_for_status()
        data = r.json()

    deployment_id = data["deployment_id"]
    console.print(f"[green]Deployment queued:[/green] {deployment_id}")

    if watch:
        _stream_logs(deployment_id)


def _stream_logs(deployment_id: str) -> None:
    console.print(f"\n[bold]Streaming logs for {deployment_id}:[/bold]")
    with httpx.Client(base_url=_API_URL, headers=_headers(), timeout=180) as c:
        with c.stream("GET", f"/api/v1/stream/{deployment_id}") as response:
            response.raise_for_status()
            for raw_line in response.iter_lines():
                if not raw_line or raw_line.startswith(":"):
                    continue
                if raw_line.startswith("data:"):
                    payload = raw_line.removeprefix("data:").strip()
                    try:
                        event = json.loads(payload)
                        level = event.get("level", "info")
                        msg = event.get("message", "")
                        colour = {"error": "red", "warn": "yellow", "progress": "green"}.get(level, "white")
                        console.print(f"[{colour}]{msg}[/{colour}]")
                        if event.get("level") == "progress" and "complete" in msg.lower():
                            break
                        if event.get("level") == "error":
                            raise typer.Exit(1)
                    except json.JSONDecodeError:
                        console.print(payload)


@app.command(name="watch")
def watch_cmd(deployment_id: str = typer.Argument(..., help="Deployment ID from deploy output")):
    """Stream live progress for an in-flight deployment."""
    _stream_logs(deployment_id)


@app.command(name="apps")
def list_apps():
    """List all deployed apps."""
    with _client() as c:
        r = c.get("/api/v1/apps")
        r.raise_for_status()
        apps = r.json()

    if not apps:
        console.print("No apps deployed.")
        return

    table = Table(title="Deployed Apps")
    table.add_column("App ID", style="cyan")
    table.add_column("Status")
    table.add_column("URL")
    table.add_column("Port")
    for a in apps:
        status_colour = {"running": "green", "failed": "red", "stopped": "yellow"}.get(a["status"], "white")
        table.add_row(
            a["app_id"],
            f"[{status_colour}]{a['status']}[/{status_colour}]",
            a.get("url") or "-",
            str(a.get("port") or "-"),
        )
    console.print(table)


@app.command(name="models")
def list_models():
    """List available models + the intent→model routing (from the LiteLLM proxy)."""
    with _client() as c:
        r = c.get("/api/v1/models")
        r.raise_for_status()
        data = r.json()

    intent_map = data.get("intent_map", {})
    if intent_map:
        imap = Table(title="Intent routing (shared defaults)")
        imap.add_column("Intent", style="cyan")
        imap.add_column("Model")
        for intent in data.get("intents", list(intent_map)):
            imap.add_row(intent, intent_map.get(intent, "-"))
        console.print(imap)

    models = data.get("models", [])
    if not models:
        console.print("No models reported by the proxy (is it reachable?).")
        return
    table = Table(title="Available Models")
    table.add_column("Model", style="cyan")
    table.add_column("Tier")
    table.add_column("In $/M")
    table.add_column("Out $/M")
    for m in models:
        table.add_row(
            m["id"], m.get("tier", "-"),
            str(m.get("input_price_per_mtok", 0)),
            str(m.get("output_price_per_mtok", 0)),
        )
    console.print(table)


@app.command(name="usage")
def show_usage():
    """Show your token/cost usage as metered by the LiteLLM proxy."""
    with _client() as c:
        r = c.get("/api/v1/usage")
        r.raise_for_status()
        data = r.json()
    rows = data.get("by_model", [])
    if not rows:
        console.print("No usage recorded yet.")
        return
    table = Table(title=f"Usage — {data.get('user', '')}")
    table.add_column("Model", style="cyan")
    table.add_column("Requests")
    table.add_column("Tokens (in/out)")
    table.add_column("Cost $")
    for r_ in rows:
        table.add_row(
            r_["model"], str(r_.get("requests", 0)),
            f"{r_.get('input_tokens', 0)}/{r_.get('output_tokens', 0)}",
            f"{r_.get('cost_usd', 0):.4f}",
        )
    console.print(table)


# ------------------------------------------------------------------
# Web UI bootstrap
# ------------------------------------------------------------------


@app.command(name="webui-bootstrap")
def webui_bootstrap(
    admin_email: str = typer.Option(..., "--admin-email", help="Email of the first admin — usually you"),
):
    """
    One-time setup for the DeployKit web UI: provisions its Postgres database
    (with pgvector enabled) and seeds the first admin.

    Recommended order: 1) run this command, 2) deploy the `webui` app (its
    own startup runs `drizzle-kit push` to create the rest of the schema),
    3) sign in — you'll already be an admin. Safe to re-run.
    """
    with _client() as c:
        console.print("Provisioning webui database (pgvector enabled)...")
        r = c.post("/api/v1/provision-db", json={"app_id": "webui", "enable_pgvector": True})
        r.raise_for_status()
        result = r.json()
    console.print(f"[green]Database provisioned:[/green] {result['db_name']}")

    console.print(f"Seeding first admin: {admin_email}")
    import psycopg2

    conn = psycopg2.connect(result["db_url"])
    try:
        cur = conn.cursor()
        # Matches the shape Drizzle's `admins` table creates (webui/lib/db/schema.ts) —
        # safe no-op if `drizzle-kit push` already ran and created it identically.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS admins (
                email    text PRIMARY KEY,
                added_by text,
                added_at timestamp DEFAULT now() NOT NULL
            )
            """
        )
        cur.execute(
            "INSERT INTO admins (email, added_by) VALUES (%s, %s) ON CONFLICT (email) DO NOTHING",
            (admin_email.lower().strip(), "bootstrap"),
        )
        conn.commit()
    finally:
        conn.close()
    console.print(f"[green]{admin_email} is now an admin.[/green] Deploy the webui app if you haven't already.")


@app.command()
def status(app_id: str = typer.Argument(...)):
    """Get status of a specific app."""
    with _client() as c:
        r = c.get(f"/api/v1/status/{app_id}")
        r.raise_for_status()
        d = r.json()
    console.print_json(json.dumps(d))


@app.command()
def logs(
    app_id: str = typer.Argument(...),
    tail: int = typer.Option(100, help="Number of lines"),
):
    """Fetch recent container logs."""
    with _client() as c:
        r = c.get(f"/api/v1/logs/{app_id}", params={"tail": tail})
        r.raise_for_status()
        console.print(r.json().get("logs", "(no logs)"))


@app.command()
def stop(app_id: str = typer.Argument(...)):
    """Stop an app without removing it."""
    with _client() as c:
        r = c.post(f"/api/v1/stop/{app_id}")
        r.raise_for_status()
    console.print(f"[yellow]Stopped[/yellow] {app_id}")


@app.command()
def start(app_id: str = typer.Argument(...)):
    """Start a stopped app."""
    with _client() as c:
        r = c.post(f"/api/v1/start/{app_id}")
        r.raise_for_status()
    console.print(f"[green]Started[/green] {app_id}")


@app.command(name="set-access")
def set_access(
    app_id: str = typer.Argument(...),
    emails: str = typer.Option("", "--emails", help="Comma-separated allowlist. Empty clears the restriction."),
    admin_only: bool = typer.Option(
        False, "--admin-only", help="Use this sandbox's ADMIN_EMAILS env var as the allowlist — the intended way to gate webui itself: `deploykit set-access webui --admin-only`."
    ),
):
    """Set (or clear) an app's per-app email allowlist, enforced at the edge by nginx.

    Immediate — regenerates the app's nginx route right away, no redeploy needed. Empty
    allowlist means no restriction beyond whatever edge SSO itself requires.
    """
    if admin_only:
        raw = os.environ.get("ADMIN_EMAILS", "")
    else:
        raw = emails
    allowed = [e.strip().lower() for e in raw.split(",") if e.strip()]
    with _client() as c:
        r = c.put(f"/api/v1/access/{app_id}", json={"allowed_emails": allowed})
        r.raise_for_status()
    if allowed:
        console.print(f"[green]{app_id} restricted to:[/green] {', '.join(allowed)}")
    else:
        console.print(f"[yellow]{app_id} allowlist cleared[/yellow] — reachable by anyone who can sign in.")


@app.command()
def undeploy(
    app_id: str = typer.Argument(...),
    keep_volumes: bool = typer.Option(False, "--keep-volumes", help="Keep data volumes"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
):
    """Remove an app and its container (and optionally volumes)."""
    if not yes:
        typer.confirm(f"Remove {app_id}?", abort=True)
    with _client() as c:
        r = c.post("/api/v1/undeploy", json={"app_id": app_id, "remove_volumes": not keep_volumes})
        r.raise_for_status()
    console.print(f"[red]Removed[/red] {app_id}")


# The MCP server command was dropped 2026-09-20 for the same reason -- it
# wrapped a module (agent/mcp_server.py) not carried into this vendored
# engine. pacmanager's own MCP bridge (demo/mcp-stdio.js) is unrelated and
# unaffected.


@app.command()
def manage():
    """
    Launch the DeployKit management TUI — sandbox install/status/lifecycle,
    edge SSO setup, managed LiteLLM model catalog, and private extension
    releases. Requires the `tui` extra: pip install "deploykit[tui]".
    """
    try:
        from ..tui.app import run as tui_run
    except ImportError:
        console.print(
            "[red]The management TUI requires the 'tui' extra.[/red] "
            'Install it with: pip install "deploykit[tui]"'
        )
        raise typer.Exit(1)
    tui_run()


if __name__ == "__main__":
    app()
