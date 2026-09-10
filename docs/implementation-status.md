# Verification record

## Bounded demo implementation

Locally verified with Node.js 24.19.0: 14 passing tests, including the full authenticated MCP/API journey, scoped collaborator isolation, upload escaping, immutable published definition, export checksums, standalone exported app startup/auth, stdio bridge, persisted state reload and failed/tampered build rejection. Core examples/spec references also pass. Node.js 22 remains the CI target.

Implemented: browser workspace; fixed claims/knowledge templates; persistent single-writer JSON store; Docker and Kubernetes build adapters; mock claims; shared notes/uploads; publish and runnable snapshot export; local setup and Kubernetes deployment generator.

Not executed in this workspace: Docker containers, Kubernetes/EKS resources, browser visual/interaction rehearsal, a live Claude/ChatGPT authoring session, or SpecGuard. Docker has a dedicated opt-in integration test and CI step. Kubernetes requires actual cluster network-policy verification. The tested process builder is explicitly labelled as having no container isolation.

Not implemented: arbitrary generated application execution, remote ChatGPT OAuth connector, CRDT collaborative documents, vector retrieval, PostgreSQL/MinIO shared-service provisioning, live API bindings/L7 proxy, PACOS agent execution, production SSO or HA. These limitations are also displayed or documented in the demo.

## Initial scaffold
Initial scaffold verified locally with Node.js 24.19.0:
- node --test: 11 passing tests, zero failures.
- node scripts/check.js: examples and living-spec references pass.
- PACOS sibling integration: six manifests validate and produce inert plans.
Node.js 22 is the declared minimum and CI target; local tests were not run on Node.js 22.
No dependencies or models were installed/called. SpecGuard source was inspected but its CLI was not executed.
No sandbox, cloud resource, database, mock/live network provider or authenticated sharing service was deployed.
GitHub CI results are separate from these local results.
