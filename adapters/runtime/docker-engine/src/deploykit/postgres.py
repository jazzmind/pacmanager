"""
Postgres provisioning for deploykit sandbox.

Each deployed app that requests a database (by including {{SANDBOX_DB_URL}} in
its env_vars) gets:
  - A dedicated database:  {app_id_underscored}
  - A dedicated user:      dk_{app_id_underscored}
  - A random 16-byte hex password

The shared Postgres instance runs as `deploykit-postgres` on the deploykit-net
Docker network.  The superuser credentials come from environment variables:

  DEPLOYKIT_PG_HOST      (default: deploykit-postgres)
  DEPLOYKIT_PG_PORT      (default: 5432)
  DEPLOYKIT_PG_USER      (default: deploykit)
  DEPLOYKIT_PG_PASSWORD  (default: deploykit)
  DEPLOYKIT_PG_DB        (default: postgres)

Usage:
    from .postgres import provision_db, deprovision_db

    db_url = await provision_db("my-app")
    # → "postgresql://dk_my_app:<password>@deploykit-postgres:5432/my_app"

    await deprovision_db("my-app")
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets

from .naming import pg_ident

_log = logging.getLogger(__name__)

_PG_HOST      = os.environ.get("DEPLOYKIT_PG_HOST", "deploykit-postgres")
_PG_PORT      = int(os.environ.get("DEPLOYKIT_PG_PORT", "5432"))
_PG_SUPERUSER = os.environ.get("DEPLOYKIT_PG_USER", "deploykit")
_PG_SUPERPW   = os.environ.get("DEPLOYKIT_PG_PASSWORD", "deploykit")
_PG_ADMIN_DB  = os.environ.get("DEPLOYKIT_PG_DB", "postgres")

SANDBOX_DB_TOKEN = "{{SANDBOX_DB_URL}}"
# Corrected 2026-09-20: "sandbox" is a deploy *target* (the shared remote host), not a
# property of Postgres provisioning itself -- this same mechanism runs identically for a
# local deploykit instance. DK_DB_TOKEN is the new, target-neutral name; SANDBOX_DB_TOKEN
# is kept working indefinitely for apps.json files that already reference it literally (see
# backends/docker.py, which now accepts either). New app definitions should use DK_DB_TOKEN.
DK_DB_TOKEN = "{{DK_DB_URL}}"


def _slug(app_id: str) -> str:
    """Convert app_id to a valid PostgreSQL identifier (hyphens → underscores)."""
    return app_id.replace("-", "_")


def _provision_sync(app_id: str, enable_pgvector: bool = False) -> str:
    """
    Create a dedicated database + user for *app_id*.
    Runs synchronously — call via asyncio.to_thread().
    Idempotent: rotates password if user already exists.
    Returns the postgresql:// connection URL for the app user.

    `enable_pgvector=True` additionally runs `CREATE EXTENSION IF NOT EXISTS
    vector` in the new database — for apps doing RAG/similarity search (e.g.
    the deploykit webui's own document embeddings). Requires the shared
    Postgres image to bundle pgvector; raises if the extension isn't available.
    """
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    db_name  = pg_ident(app_id)
    username = db_name
    password = secrets.token_hex(16)

    conn = psycopg2.connect(
        host=_PG_HOST, port=_PG_PORT,
        user=_PG_SUPERUSER, password=_PG_SUPERPW,
        dbname=_PG_ADMIN_DB,
    )
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()
    try:
        # Create / update user
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (username,))
        if cur.fetchone():
            cur.execute(f'ALTER USER "{username}" WITH PASSWORD %s', (password,))
            _log.info("postgres: rotated password for %s", username)
        else:
            cur.execute(
                f'CREATE USER "{username}" WITH PASSWORD %s '
                f'NOSUPERUSER NOCREATEDB NOCREATEROLE',
                (password,),
            )
            _log.info("postgres: created user %s", username)

        # Create database (owned by superuser for easier cleanup)
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
        if not cur.fetchone():
            cur.execute(f'CREATE DATABASE "{db_name}"')
            _log.info("postgres: created database %s", db_name)

        # Restrict public access; grant to app user only
        cur.execute(f'REVOKE ALL ON DATABASE "{db_name}" FROM PUBLIC')
        cur.execute(f'GRANT ALL PRIVILEGES ON DATABASE "{db_name}" TO "{username}"')
    finally:
        cur.close()
        conn.close()

    # Grant schema-level privileges (must connect to the target DB)
    conn2 = psycopg2.connect(
        host=_PG_HOST, port=_PG_PORT,
        user=_PG_SUPERUSER, password=_PG_SUPERPW,
        dbname=db_name,
    )
    conn2.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur2 = conn2.cursor()
    try:
        cur2.execute(f'GRANT ALL ON SCHEMA public TO "{username}"')
        cur2.execute(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            f'GRANT ALL ON TABLES TO "{username}"'
        )
        cur2.execute(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            f'GRANT ALL ON SEQUENCES TO "{username}"'
        )
        if enable_pgvector:
            # Extensions are installed once (as superuser) per database; any
            # user connected to this database can then use the `vector` type.
            cur2.execute("CREATE EXTENSION IF NOT EXISTS vector")
            _log.info("postgres: enabled pgvector extension on %s", db_name)
    finally:
        cur2.close()
        conn2.close()

    url = f"postgresql://{username}:{password}@{_PG_HOST}:{_PG_PORT}/{db_name}"
    _log.info("postgres: provisioned %s → %s", app_id, db_name)
    return {
        "db_url": url,
        "db_user": username,
        "db_password": password,
        "db_name": db_name,
    }


def _deprovision_sync(app_id: str) -> None:
    """
    Drop the database and user for *app_id*.
    Runs synchronously — call via asyncio.to_thread().
    """
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    db_name  = pg_ident(app_id)
    username = db_name

    conn = psycopg2.connect(
        host=_PG_HOST, port=_PG_PORT,
        user=_PG_SUPERUSER, password=_PG_SUPERPW,
        dbname=_PG_ADMIN_DB,
    )
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()
    try:
        # Terminate active connections before dropping
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND pid <> pg_backend_pid()",
            (db_name,),
        )
        cur.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        cur.execute(f'DROP USER IF EXISTS "{username}"')
        _log.info("postgres: deprovisioned %s", app_id)
    finally:
        cur.close()
        conn.close()


async def provision_db(app_id: str, enable_pgvector: bool = False) -> dict:
    """Async wrapper around _provision_sync. Returns {db_url, db_user, db_password, db_name}."""
    return await asyncio.to_thread(_provision_sync, app_id, enable_pgvector)


async def deprovision_db(app_id: str) -> None:
    """Async wrapper around _deprovision_sync."""
    await asyncio.to_thread(_deprovision_sync, app_id)
