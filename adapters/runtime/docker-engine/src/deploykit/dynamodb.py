"""
DynamoDB store provisioning for deploykit sandbox.

Each deployed app that requests a DynamoDB-backed store (by including any of
the SANDBOX_DDB_TOKENS sentinels in its env_vars) gets:
  - A dedicated table-name prefix:  dk_{app_id_underscored}_
  - A deterministic (per-app) access key id
  - A random 16-byte (32-character) hex secret access key, rotated on every
    provision call

The shared DynamoDB-local instance runs as `deploykit-dynamodb` on the
deploykit-net Docker network, with -sharedDb (so storage isn't partitioned by
access key — a dynamodb-local-only quirk that doesn't exist on real AWS;
isolation between apps here is by table-name prefix instead, so the same app
code works unchanged against real AWS). Endpoint/region come from environment
variables:

  DEPLOYKIT_DDB_ENDPOINT  (default: http://deploykit-dynamodb:8000)
  DEPLOYKIT_DDB_REGION    (default: us-east-1)

deploykit provisions the *store* (a table-name-prefix + credentials) — it does
NOT create the app's own DynamoDB tables. The app itself is responsible for
creating its schema on boot (mirrors the Postgres precedent, where the app
runs its own migrations against a deploykit-provisioned database).

Usage:
    from .dynamodb import provision_store, deprovision_store

    result = await provision_store("my-app")
    # → {
    #     "endpoint": "http://deploykit-dynamodb:8000",
    #     "region": "us-east-1",
    #     "table_prefix": "dk_my_app_",
    #     "access_key_id": "dkmyapp",
    #     "secret_access_key": "<32-char hex>",
    #   }

    await deprovision_store("my-app")
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets

from .naming import RESOURCE_PREFIX, ddb_table_prefix

_log = logging.getLogger(__name__)

_DDB_ENDPOINT = os.environ.get("DEPLOYKIT_DDB_ENDPOINT", "http://deploykit-dynamodb:8000")
_DDB_REGION = os.environ.get("DEPLOYKIT_DDB_REGION", "us-east-1")

SANDBOX_DDB_TOKENS = {
    "{{SANDBOX_DDB_ENDPOINT}}":          "endpoint",
    "{{SANDBOX_DDB_REGION}}":            "region",
    "{{SANDBOX_DDB_TABLE_PREFIX}}":      "table_prefix",
    "{{SANDBOX_DDB_ACCESS_KEY_ID}}":     "access_key_id",
    "{{SANDBOX_DDB_SECRET_ACCESS_KEY}}": "secret_access_key",
}
# Corrected 2026-09-20: same rename as postgres.py's DK_DB_TOKEN, same reason -- "sandbox"
# describes a deploy target, not a property of DynamoDB provisioning. DK_DDB_TOKENS is the
# new, target-neutral name; SANDBOX_DDB_TOKENS is kept working indefinitely (see
# backends/docker.py, which now accepts either set). New app definitions should use
# DK_DDB_TOKENS.
DK_DDB_TOKENS = {
    "{{DK_DDB_ENDPOINT}}":          "endpoint",
    "{{DK_DDB_REGION}}":            "region",
    "{{DK_DDB_TABLE_PREFIX}}":      "table_prefix",
    "{{DK_DDB_ACCESS_KEY_ID}}":     "access_key_id",
    "{{DK_DDB_SECRET_ACCESS_KEY}}": "secret_access_key",
}


def _slug(app_id: str) -> str:
    """Convert app_id to a valid identifier (hyphens → underscores)."""
    return app_id.replace("-", "_")


def _access_key_slug(app_id: str) -> str:
    """
    Convert app_id to a valid AWS access-key-id fragment: alphanumeric only.

    Confirmed by live testing against the sandbox's amazon/dynamodb-local
    image: unlike older builds, this one validates the access key format and
    rejects hyphens/underscores with UnrecognizedClientException even though
    it ignores the credential VALUE otherwise. `_slug()` (used for the table
    prefix, where underscores are valid) is NOT safe to reuse here.
    """
    return "".join(ch for ch in app_id if ch.isalnum())


def _client(access_key_id: str, secret_access_key: str):
    """Build a boto3 DynamoDB client pointed at the sandbox's dynamodb-local endpoint.

    dynamodb-local ignores the VALUES of these credentials, but the AWS SDK
    requires SOME credentials to be present — a real access key / secret pair
    is never needed here, just non-empty strings.
    """
    import boto3

    return boto3.client(
        "dynamodb",
        endpoint_url=_DDB_ENDPOINT,
        region_name=_DDB_REGION,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    )


def _provision_sync(app_id: str) -> dict:
    """
    Provision a DynamoDB store for *app_id*: a table-name prefix and a fresh
    set of (placeholder) credentials. Runs synchronously — call via
    asyncio.to_thread().

    Idempotent: the table_prefix is always the same deterministic value for a
    given app_id; the secret_access_key rotates on every call (mirroring
    postgres.py's password-rotation-on-reprovision behaviour).

    Verifies connectivity to the shared dynamodb-local endpoint via
    `list_tables()`; raises a clear exception if the endpoint is unreachable.

    Does NOT create the app's own tables — that is the app's responsibility
    on boot (see module docstring).
    """
    table_prefix = ddb_table_prefix(app_id)
    access_key_id = f"{RESOURCE_PREFIX}{_access_key_slug(app_id)}"
    secret_access_key = secrets.token_hex(16)

    client = _client(access_key_id, secret_access_key)
    try:
        client.list_tables()
    except Exception as exc:
        raise RuntimeError(
            f"dynamodb: could not reach dynamodb-local at {_DDB_ENDPOINT} "
            f"while provisioning {app_id}: {exc}"
        ) from exc

    _log.info("dynamodb: provisioned %s → prefix %s", app_id, table_prefix)
    return {
        "endpoint": _DDB_ENDPOINT,
        "region": _DDB_REGION,
        "table_prefix": table_prefix,
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
    }


def _deprovision_sync(app_id: str) -> None:
    """
    Delete every table whose name starts with *app_id*'s table_prefix.
    Runs synchronously — call via asyncio.to_thread().

    Safe to call when no tables exist (idempotent teardown), mirroring
    postgres.py's DROP ... IF EXISTS semantics.

    Note: on real AWS, delete_table() is asynchronous and can raise
    ResourceInUseException while a table is still deleting, requiring a
    wait-until-deleted retry loop. dynamodb-local's deletes are effectively
    instant, so this stays a simple fire-and-forget loop for the sandbox case.
    """
    table_prefix = ddb_table_prefix(app_id)
    # Credential values are irrelevant to dynamodb-local; any non-empty
    # alphanumeric-only strings authenticate against the shared -sharedDb
    # namespace (see _access_key_slug's docstring for why alphanumeric-only).
    client = _client(f"{RESOURCE_PREFIX}{_access_key_slug(app_id)}", "deprovision")

    try:
        table_names = client.list_tables().get("TableNames", [])
    except Exception as exc:
        _log.warning("dynamodb: could not list tables while deprovisioning %s: %s", app_id, exc)
        return

    matching = [name for name in table_names if name.startswith(table_prefix)]
    for name in matching:
        try:
            client.delete_table(TableName=name)
            _log.info("dynamodb: deleted table %s (app %s)", name, app_id)
        except Exception as exc:
            _log.warning("dynamodb: failed to delete table %s for %s: %s", name, app_id, exc)

    _log.info("dynamodb: deprovisioned %s (%d table(s) removed)", app_id, len(matching))


async def provision_store(app_id: str) -> dict:
    """Async wrapper around _provision_sync.

    Returns {endpoint, region, table_prefix, access_key_id, secret_access_key}.
    """
    return await asyncio.to_thread(_provision_sync, app_id)


async def deprovision_store(app_id: str) -> None:
    """Async wrapper around _deprovision_sync."""
    await asyncio.to_thread(_deprovision_sync, app_id)
