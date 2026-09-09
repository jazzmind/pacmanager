# Control API and MCP design (not implemented)
HTTP JSON API is the canonical service interface; MCP and CLI are adapters. Every mutation requires authenticated user/role, idempotency key and optimistic version check. All resources are tenant scoped. Tool annotations are advisory, not enforcement.

| Method/path | Intent | Preconditions |
|---|---|---|
| POST /v1/artifacts | Create draft identity | Creator policy, quota |
| PUT /v1/artifacts/{id}/draft | Update source reference/manifest | Editor; If-Match revision |
| POST /v1/artifacts/{id}/builds | Queue isolated build | Template and dependency policy |
| GET /v1/builds/{id} | Inspect bounded/redacted results | Read access |
| POST /v1/artifacts/{id}/releases | Publish immutable build | Evidence plus grants, owner, audience |
| POST /v1/grant-requests | Request a capability | Declared request only |
| POST /v1/grants | Issue authority | Independent authorized approver |
| DELETE /v1/grants/{id} | Revoke authority | Grant administrator |
| POST /v1/artifacts/{id}/exports | Prepare graduation | Source AND data export permissions |
| POST /v1/agent-packs | Register versioned pack | Validate contracts, trust policy |
| POST /v1/agent-runs | Run bounded agent | Explicit activation and budget |

MCP names: artifact_create, artifact_update_draft, artifact_build, artifact_inspect, artifact_publish, capability_request, artifact_export, agent_pack_register.
No shell-equivalent control tool. Long jobs return operation IDs and support cancellation.
Errors: 400 malformed input, 401 no identity, 403 denied, 404 absent/inaccessible, 409 stale version, 413 size, 422 contract failure, 429 quota, 503 unavailable. Failure of policy/identity services denies privileged operations.

