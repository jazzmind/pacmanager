"""One place for every name this engine gives to something shared.

The engine can run next to another platform on the same Docker daemon, Postgres, DynamoDB and
nginx (pacmanager beside deploykit on the sandbox). Everything it creates in a shared namespace
carries RESOURCE_PREFIX, so two engines can never collide on a container, image, database, role,
table prefix or nginx route file, and one platform's undeploy can't touch the other's data.

Default "pac"; override with DEPLOYKIT_RESOURCE_PREFIX (lowercase letters/digits).
"""
from __future__ import annotations

import hashlib
import os
import re

RESOURCE_PREFIX = os.environ.get("DEPLOYKIT_RESOURCE_PREFIX", "pac")
if not re.fullmatch(r"[a-z][a-z0-9]{0,15}", RESOURCE_PREFIX):
    raise ValueError(f"DEPLOYKIT_RESOURCE_PREFIX must be 1-16 lowercase letters/digits, got {RESOURCE_PREFIX!r}")

_PG_IDENT_MAX = 63  # Postgres silently truncates longer identifiers, which could merge two apps


def container_name(app_id: str) -> str:
    return f"{RESOURCE_PREFIX}-{app_id}"


def image_tag(app_id: str) -> str:
    return f"{RESOURCE_PREFIX}/{app_id}:latest"


def conf_name(app_id: str) -> str:
    """nginx route file name; the prefix keeps it inside this engine's namespace in a shared dir."""
    return f"{RESOURCE_PREFIX}-{app_id}.conf"


def app_id_from_conf(stem: str) -> str:
    return stem[len(RESOURCE_PREFIX) + 1:] if stem.startswith(RESOURCE_PREFIX + "-") else stem


def pg_ident(app_id: str) -> str:
    """Database name AND role name for an app: `<prefix>_<slug>` (hyphens -> underscores).

    Over the 63-char limit, truncate and append a hash of the full id, so two long ids that
    share a prefix still get distinct identifiers (Postgres would otherwise truncate both alike).
    """
    ident = f"{RESOURCE_PREFIX}_{app_id.replace('-', '_')}"
    if len(ident) <= _PG_IDENT_MAX:
        return ident
    digest = hashlib.sha256(app_id.encode()).hexdigest()[:8]
    return f"{ident[:_PG_IDENT_MAX - 9]}_{digest}"


def ddb_table_prefix(app_id: str) -> str:
    """`<prefix>.<app_id>.` -- '.' can't appear in a pacmanager app id, so `foo.` is never a
    prefix of `foo-bar.` (the old `dk_<slug>_` scheme made undeploying `foo` delete `foo-bar`'s tables)."""
    if "." in app_id:
        raise ValueError(f"app id {app_id!r} may not contain '.' (it delimits the DynamoDB table prefix)")
    return f"{RESOURCE_PREFIX}.{app_id}."
