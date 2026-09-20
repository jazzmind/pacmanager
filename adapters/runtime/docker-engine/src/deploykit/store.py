"""
SQLite-backed deployment state store.

Standalone default — no Postgres required.  busibox/deploy-api can swap in a
Postgres-backed implementation by subclassing or providing an alternate store.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import aiosqlite

_DEFAULT_DB = Path(os.environ.get("DEPLOYKIT_DB", "/var/lib/deploykit/state.db"))

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS deployments (
    deployment_id TEXT NOT NULL,
    app_id        TEXT NOT NULL,
    status        TEXT NOT NULL,
    port          INTEGER,
    container_id  TEXT,
    url           TEXT,
    error         TEXT,
    extra         TEXT DEFAULT '{}',
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    PRIMARY KEY (app_id)
);
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL,
    ts            REAL NOT NULL,
    level         TEXT NOT NULL,
    message       TEXT NOT NULL
);
"""


class DeploymentStore:
    def __init__(self, db_path: Path | None = None) -> None:
        self._path = db_path or _DEFAULT_DB

    @asynccontextmanager
    async def _db(self) -> AsyncIterator[aiosqlite.Connection]:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(str(self._path)) as db:
            db.row_factory = aiosqlite.Row
            await db.executescript(_CREATE_TABLE)
            yield db

    async def upsert(
        self,
        deployment_id: str,
        app_id: str,
        status,
        port: int | None = None,
        container_id: str | None = None,
        url: str | None = None,
        error: str | None = None,
        extra: dict | None = None,
    ) -> None:
        """Insert or update a deployment row.

        `extra` is shallow-merged onto the existing stored blob when given (new
        keys win, other existing keys survive), and left untouched entirely when
        omitted (`None`). Callers like stop()/start() that call upsert() without
        `extra` rely on this — a plain overwrite here would silently wipe fields
        like description/owner/manifest data on every stop/start cycle.
        """
        now = time.time()
        async with self._db() as db:
            extra_json: str | None = None
            if extra is not None:
                cur = await db.execute("SELECT extra FROM deployments WHERE app_id = ?", (app_id,))
                row = await cur.fetchone()
                base = json.loads(row["extra"]) if row and row["extra"] else {}
                extra_json = json.dumps({**base, **extra})

            await db.execute(
                """
                INSERT INTO deployments
                    (deployment_id, app_id, status, port, container_id, url, error, extra, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, '{}'), ?, ?)
                ON CONFLICT(app_id) DO UPDATE SET
                    deployment_id = excluded.deployment_id,
                    status        = excluded.status,
                    port          = COALESCE(excluded.port, port),
                    container_id  = COALESCE(excluded.container_id, container_id),
                    url           = COALESCE(excluded.url, url),
                    error         = excluded.error,
                    extra         = COALESCE(?, extra),
                    updated_at    = excluded.updated_at
                """,
                (
                    deployment_id,
                    app_id,
                    str(status.value if hasattr(status, "value") else status),
                    port,
                    container_id,
                    url,
                    error,
                    extra_json,
                    now,
                    now,
                    extra_json,
                ),
            )
            await db.commit()

    async def get(self, app_id: str) -> dict | None:
        async with self._db() as db:
            async with db.execute(
                "SELECT * FROM deployments WHERE app_id = ?", (app_id,)
            ) as cur:
                row = await cur.fetchone()
                return dict(row) if row else None

    async def list_all(self) -> list[dict]:
        async with self._db() as db:
            async with db.execute(
                "SELECT * FROM deployments ORDER BY updated_at DESC"
            ) as cur:
                rows = await cur.fetchall()
                return [dict(r) for r in rows]

    async def append_event(self, deployment_id: str, ts: float, level: str, message: str) -> None:
        async with self._db() as db:
            await db.execute(
                "INSERT INTO events (deployment_id, ts, level, message) VALUES (?, ?, ?, ?)",
                (deployment_id, ts, level, message),
            )
            await db.commit()

    async def get_events(self, deployment_id: str) -> list[dict]:
        async with self._db() as db:
            async with db.execute(
                "SELECT * FROM events WHERE deployment_id = ? ORDER BY ts",
                (deployment_id,),
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]
