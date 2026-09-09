# Architecture
## Boundary-first design
Authoring clients -> authenticated control API -> isolated build workers -> immutable releases.
Users -> identity-aware ingress -> artifact workloads.
Workloads -> capability broker -> scoped data, models, simulations or approved live connectors.
The control plane stores desired state but cannot be called using workload credentials.

## Artifact, release, grant and binding
Artifact is stable ownership/catalog identity. Release is immutable code/config digest plus build evidence. Grant is authority issued outside generated code, scoped to principal, release digest, operation, environment and expiry. Binding maps a versioned logical contract to a provider. Draft manifests request permissions; they never grant them.
The alpha evaluator binds a canonical manifest digest containing an image digest. Production must include verified build provenance and immutable config digests as well.
User-delegated calls preserve the end-user identity. Background service calls have distinct, explicitly scoped principals. Never substitute the artifact owner's broad identity.

## Authoring versus execution
MCP is a control-plane transport, not a sandbox, authentication scheme or portable app runtime. Git stores code/design history, not collaborative document contents or production records.
Cloud authoring requires an explicit authenticated public endpoint or approved private-connectivity mechanism. No blanket inbound block can coexist with a reachable control API without a narrow exception. Returned logs, documents and previews are outbound data disclosures to the AI client and require policy too.

## Build plane
Generate from an approved template; resolve locked dependencies through a curated mirror; run untrusted builds away from secrets and the control plane. Buildpack scripts are also arbitrary code. Produce OCI image, SBOM, tests and provenance. Promotion accepts an immutable digest, not a mutable tag.
Kubernetes is a proposed target adapter, not an implemented dependency of this core. Node reference logic should remain reusable; introduce Go operators only when an actual operator is justified.

## Runtime
A trusted adapter provisions sandboxed workloads (gVisor or VM-backed tier), fail-closed ingress/egress, process limits, storage isolation and service identity. No shared Docker socket, host mounts, cluster credentials, metadata endpoint or direct internet.
The adapter must prove actual denied network paths. A NetworkPolicy file or pure policy test alone is not proof.
Local CLI is for trusted development only; no enterprise-data security equivalence is claimed.

## Data
Default to per-artifact database/role and object bucket/policy; vectors can live in the same database. Provision credentials only for that artifact; enterprise credentials remain broker-held. Logical separation is not physical isolation: document pooled infrastructure blast radius and offer dedicated instances for higher risk.
Database ownership does not imply platform superuser. Migration roles are separate from runtime roles. Quotas cover queries/connections/storage as well as compute.
Redis is deferred. pgvector/S3-compatible implementations remain replaceable bindings.

## Artifact kinds
Applications use conventional source and HTTP/SQL/object APIs. Agents add bounded execution, model and tool budgets. Documents need structured content, collaborative transactions and server-side permissions. Knowledge needs ingestion, citations, source ACLs and deletion propagation. Workflow imports preserve native definitions.
Only contract/planning behavior is implemented in the scaffold.

