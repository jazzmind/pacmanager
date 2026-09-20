"""
SharedTokenAuthProvider — v1 auth for standalone deploykit.

Auth boundary design (per user spec):
  dev  ─(SSH user/pass)─►  bastion/tunnel
  bastion  ─(shared bearer token)─►  deploy-api (:8011)

The bastion (or the SSH tunnel user's CLI) sends:
  Authorization: Bearer <DEPLOYKIT_TOKEN>
  X-Deploy-User: <username>          ← optional, for attribution/audit

No busibox authz service required.
"""

from __future__ import annotations

import os
import secrets

from fastapi import Request

from ..models import Principal
from .base import AuthError, AuthProvider

_TOKEN_ENV = "DEPLOYKIT_TOKEN"


class SharedTokenAuthProvider(AuthProvider):
    def __init__(self, token: str | None = None) -> None:
        self._token = token or os.environ.get(_TOKEN_ENV, "")
        if not self._token:
            raise ValueError(
                f"SharedTokenAuthProvider requires a token via {_TOKEN_ENV} env var "
                "or the token= constructor argument."
            )

    async def authenticate(self, request: Request) -> Principal:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise AuthError("Missing or malformed Authorization header", 401)

        provided = auth_header.removeprefix("Bearer ").strip()
        if not secrets.compare_digest(provided, self._token):
            raise AuthError("Invalid token", 401)

        # X-Deploy-User carries the dev identity for attribution; optional.
        user_id = request.headers.get("X-Deploy-User", "unknown")
        return Principal(user_id=user_id, auth_method="shared_token")
