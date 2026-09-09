# Roadmap and acceptance gates
## M0: this scaffold
Contract validation, deterministic digest, scoped grant evaluation, plan/export CLI, independent tests, docs and PACOS compatibility. No runtime security claims.
## M1: useful local experience
Authenticated API + persistent draft/release store + MCP SDK adapter; approved data-app template; mock provider; source build/preview; library and sharing UI.
Exit: a synthetic-data app is created, edited, previewed and restored by a new contributor using one documented path.
## M2: safe shared host
Sandbox adapter; actual network deny enforcement; per-artifact browser origin/CSP; scoped Postgres/object storage; identity/grants; signed builds; backups and quotas.
Exit: independent adversarial isolation suite and restore exercise pass. No real enterprise data before this gate.
## M3: knowledge and collaborations
Versioned document blocks; room membership authorization; citations; scoped ingestion; ACL/deletion propagation; export/import.
Exit: revocation test removes derived access and a clean import retains content/permissions.
## M4: ecosystem + graduation
One external agent/workflow provider, one verified enterprise mock/live contract, source/data graduation round trip, opt-in PACOS operation.
Exit: engineer runs exported app independently and community agents remain within grants under prompt injection.

## First contribution tracks
Contract schema parity and fuzz cases; mock provider conformance; runtime deny tests; data export round trip; accessible library prototype; SpecGuard adapter compatibility. Publish small acceptance-scoped issues after maintainers approve the backlog.

