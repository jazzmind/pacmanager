# Extension contracts
Plugins must describe their type, version, manifest digest, compatibility range, requested capabilities, input/output schemas, resource limits and license.

Types:
- Authoring adapter: MCP/CLI/API mapping for a client. Cannot bypass lifecycle policy.
- Artifact pack: template source, PAC contract, tests, migration and export rules.
- Capability provider: versioned OpenAPI/JSON Schema interface, mock fixtures and live adapter.
- Runtime adapter: reconcile release, inspect health, stop, revoke and destroy.
- Evidence provider: SpecGuard, scanners, evaluation engines. Outputs reports, never approval.
- Graduation exporter: source/data/evidence conversion into a named target.

Executable plugins run out of process in their own sandbox, with explicit grants. No dynamic imports of community code into the trusted control plane. Installation is not permission approval. Signatures prove origin, not safety.

## Provider invocation envelope (proposed)
requestId, artifactId, releaseDigest, principalId, tenantId, capability, operation, bindingRevision, payload, deadline.
The broker derives identity fields from authenticated context; client-supplied identity fields are ignored.
Result includes typed output, source references, redacted audit metadata and contract revision.

## Mock/live contract
Same logical operation and input/output contract, separate environment identity and state.
Bindings are versioned. Mock success does not prove live correctness: verify provider contracts, nonproduction integration, authorization, idempotency and side effects.
Promote code/config, never synthetic records or mock queues into live state. Invalidate prior grants when bindings change. Show users an unmistakable mock/live badge.

## PACOS
PACOS agents ship as artifact manifests plus instruction files and policy declarations. Registration is supported as local validation through the shared contract; remote install/start APIs are roadmap items.

