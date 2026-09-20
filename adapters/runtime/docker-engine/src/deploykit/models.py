"""Core domain models — no busibox/authz dependencies."""

from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class DeploymentStatus(str, Enum):
    PENDING = "pending"
    BUILDING = "building"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"
    REMOVED = "removed"


class AppSpec(BaseModel):
    """Generic app descriptor — maps to/from busibox BusiboxManifest."""

    id: str = Field(..., description="Unique app identifier (slug, no spaces)")
    name: str = Field(..., description="Human-readable name")
    description: str | None = Field(None, description="Short description shown on the sandbox dashboard.")
    owner: str | None = Field(None, description="App owner or team name.")
    image: str | None = Field(None, description="Docker image (pull path). Mutually exclusive with repo_url/local_path.")
    repo_url: str | None = Field(None, description="Git repo to clone and build.")
    local_path: str | None = Field(None, description="App source already rsynced to sandbox (relative to WORKDIR_BASE). Mutually exclusive with image/repo_url.")
    repo_branch: str = "main"
    dockerfile: str = "Dockerfile"
    build_command: str | None = None
    start_command: str | None = None
    port: int = Field(3000, description="Port the app listens on inside the container.")
    path_prefix: str | None = Field(None, description="nginx path prefix. Defaults to /{id}.")
    health_endpoint: str = "/health"
    env_vars: dict[str, str] = Field(default_factory=dict)
    memory_limit: str = "512m"
    cpu_limit: str = "0.5"
    labels: dict[str, str] = Field(default_factory=dict)
    sync_capable: bool = Field(
        False,
        description=(
            "Opt in to fast sync deploys. Bind-mounts the local source directory into "
            "the container (with a persistent named volume for node_modules) instead of "
            "baking it into the image. Requires the app's own entrypoint (e.g. start.sh) "
            "to install deps and build itself at container start, since the image no "
            "longer bakes a working /app. Only meaningful with local_path."
        ),
    )

    # --- Dashboard/manifest presentation fields -----------------------------
    icon_url: str | None = Field(None, description="Small square logo/icon shown on the dashboard card.")
    screenshot_url: str | None = Field(None, description="Background/hero image shown on the dashboard card.")
    creator_contact: str | None = Field(None, description="Creator contact info (email/slack) shown on the dashboard card and admin section.")
    project: str | None = Field(
        None,
        description=(
            "Group/stack id for related services (e.g. a frontend + its API) so the "
            "dashboard renders them as one card stack instead of separate cards. "
            "Auto-derived from `id` when not set — see `effective_project`."
        ),
    )
    service_role: str | None = Field(
        None, description="Optional label for this service within its project stack, e.g. 'frontend', 'backend', 'api'."
    )
    allowed_emails: list[str] = Field(
        default_factory=list,
        description=(
            "Per-app access allowlist, lowercase emails. Empty (default) means no "
            "restriction beyond whatever the edge SSO gate itself requires -- the app is "
            "reachable by anyone who can sign in. Non-empty enforces a per-app check in "
            "the generated nginx location against X-Forwarded-Email (set by oauth2-proxy "
            "in reverse-proxy mode; see proxy/nginx.py). Meaningless without edge SSO "
            "enabled, since X-Forwarded-Email is simply absent otherwise -- an app with a "
            "non-empty allowlist and no SSO in front of it is unreachable by everyone."
        ),
    )

    @property
    def effective_path(self) -> str:
        return self.path_prefix or f"/{self.id}"

    @property
    def effective_project(self) -> str:
        """The project/stack id this app groups under on the dashboard.

        Explicit `project` always wins. Otherwise strip a known service-role
        suffix from `id` (e.g. "project-tracker-api" -> "project-tracker") so
        paired frontend/backend apps stack together without any manifest change.
        """
        if self.project:
            return self.project
        for suffix in _PROJECT_GROUP_SUFFIXES:
            if self.id.endswith(suffix) and len(self.id) > len(suffix):
                return self.id[: -len(suffix)]
        return self.id

    def model_post_init(self, __context: Any) -> None:
        if not (self.image or self.repo_url or self.local_path):
            raise ValueError("AppSpec requires one of: image, repo_url, local_path")


_PROJECT_GROUP_SUFFIXES = ("-api", "-backend", "-frontend", "-ui", "-web", "-server", "-client")


class DeploymentEvent(BaseModel):
    """A single log/progress event streamed during deployment."""

    ts: float = Field(default_factory=time.time)
    level: str = "info"  # info | warn | error | progress
    message: str
    deployment_id: str


class DeploymentResult(BaseModel):
    """Result returned by deploy/undeploy/stop operations."""

    deployment_id: str
    app_id: str
    status: DeploymentStatus
    url: str | None = None
    port: int | None = None
    container_id: str | None = None
    error: str | None = None
    created_at: float = Field(default_factory=time.time)


class AppSummary(BaseModel):
    """Compact representation for list operations."""

    app_id: str
    name: str
    status: DeploymentStatus
    url: str | None = None
    port: int | None = None
    deployed_at: float | None = None
    description: str | None = None
    # Who originally deployed this app (Principal.user_id from the first
    # successful deploy — never overwritten by a later deploy/sync from a
    # different user, so an app stays attributed to its original owner even
    # after a teammate helps redeploy it). None for apps deployed before this
    # field existed. Distinct from `owner`, which is free-text set by whoever
    # wrote the app's own AppSpec and may not match who actually ran deploy().
    deployed_by: str | None = None
    owner: str | None = None
    creator_contact: str | None = None
    screenshot_url: str | None = None
    icon_url: str | None = None
    project: str | None = None
    service_role: str | None = None


class DeployRequest(BaseModel):
    spec: AppSpec
    wait_for_healthy: bool = True
    timeout_seconds: int = 120


class UndeployRequest(BaseModel):
    app_id: str
    remove_volumes: bool = True


class Principal(BaseModel):
    """Authenticated caller identity — available for audit regardless of auth method."""

    user_id: str
    display_name: str | None = None
    auth_method: str = "unknown"
