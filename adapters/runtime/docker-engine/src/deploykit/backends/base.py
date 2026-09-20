"""Abstract DeployBackend interface — implement once, swap Docker ↔ k8s ↔ EKS."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from ..models import AppSpec, AppSummary, DeploymentEvent, DeploymentResult


class DeployBackend(ABC):
    """
    Deployment backend interface.

    Implement for each substrate (Docker, k3s, EKS).  The service layer talks only
    to this interface — backends are fully interchangeable.
    """

    @abstractmethod
    async def deploy(
        self,
        spec: AppSpec,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        """
        Deploy an app.  Yields progress events; final event carries the result.
        Caller determines whether to wait or stream.

        `deployed_by` is the calling Principal.user_id — recorded as the app's
        original owner on first deploy only; a later deploy/sync by a
        different user never overwrites it (see docker.py's implementation).
        """
        ...

    @abstractmethod
    async def sync(
        self,
        app_id: str,
        deployment_id: str,
        deployed_by: str | None = None,
    ) -> AsyncIterator[DeploymentEvent]:
        """
        Push already-synced source into a running, sync-capable container and
        restart it in place — no image build. Falls back to a full `deploy()`
        if the container doesn't exist yet or predates sync support.
        """
        ...

    @abstractmethod
    async def undeploy(self, app_id: str, remove_volumes: bool = True) -> DeploymentResult:
        """Stop and remove an app and its resources."""
        ...

    @abstractmethod
    async def stop(self, app_id: str) -> DeploymentResult:
        """Stop an app without removing it."""
        ...

    @abstractmethod
    async def start(self, app_id: str) -> DeploymentResult:
        """Start a previously stopped app."""
        ...

    @abstractmethod
    async def status(self, app_id: str) -> DeploymentResult:
        """Return the current status of an app."""
        ...

    @abstractmethod
    async def list_apps(self) -> list[AppSummary]:
        """Return all known apps and their current status."""
        ...

    @abstractmethod
    async def get_logs(self, app_id: str, tail: int = 100) -> str:
        """Fetch recent logs from an app's container."""
        ...

    @abstractmethod
    async def health_check(self) -> dict:
        """Backend self-health (container engine reachable, etc.)."""
        ...
