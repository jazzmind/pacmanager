"""Pluggable auth interface. No busibox/authz dependency."""

from __future__ import annotations

from abc import ABC, abstractmethod

from fastapi import Request

from ..models import Principal


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.status_code = status_code


class AuthProvider(ABC):
    """
    Authenticate a FastAPI request and return a Principal.

    Implementations:
      - SharedTokenAuthProvider  (v1 standalone: shared bearer + X-Deploy-User)
      - JwtAuthProvider          (busibox-compatible: RS256 JWT via JWKS)
    """

    @abstractmethod
    async def authenticate(self, request: Request) -> Principal:
        """Raise AuthError if the request is not authorized."""
        ...
