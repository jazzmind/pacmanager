# Threat model and required controls
## Trust assumptions
Generated code, dependency scripts, documents, repository issues, remote tool descriptions and plugin outputs are untrusted. Administrators and the enforcement plane are trusted but auditable. Compromised admin infrastructure is outside the artifact isolation guarantee.

| Threat | Required enforcement | Verification before shared hosting |
|---|---|---|
| Lateral artifact access | Workload isolation, scoped data identities, no shared writable mounts | Attempt cross-artifact reads, writes and socket access |
| SSRF / egress bypass | Network-layer deny plus controlled L7 broker | Direct IPv4/IPv6, DNS, redirects, metadata, alternate protocols and CONNECT tests |
| Browser exfiltration | Per-artifact origins, restrictive CSP, sandboxed embeds, constrained downloads | Image/font/beacon/WebSocket/navigation tests; CORS is not a firewall |
| Confused deputy | User AND artifact AND source permissions at broker | Missing user, wrong tenant, object IDs, delegated identity tests |
| Self-escalation | Grants outside source; verified workload identity | Modified manifest, stolen approval, stale release, forged headers |
| Build compromise | Isolated builders, no deploy credentials, curated dependency source | Malicious install script cannot reach data/control plane |
| Prompt injection | External text cannot select privileges or alter approved policies | Issues/docs containing instructions to publish, leak keys or disable tests |
| Stored knowledge leaks | Permission filtering at retrieval and response; deletion lineage | Revocation removes raw files, chunks, vectors, caches and generated copies |
| Noisy neighbor | Quotas, timeouts, query controls, model budgets | Resource exhaustion without cross-tenant outage |
| Audit exfiltration | Redaction, bounded logs and access checks | Secrets and restricted document excerpts absent from telemetry |
| Approval races | Payload digest, expiry, atomic consume and revocation | Changed payload/reused approval denied |

## L7 is necessary, not sufficient
Use explicit HTTP adapters with upstream TLS verification to authorize method/path/body; a domain allowlist does not enforce application semantics. Native PostgreSQL/S3 access needs per-artifact identities and DB/object policies, not an HTTP-only gateway. DNS and inbound responses also carry data.

## Model access
Sending content to a model is egress, including embedding, reranking, evaluations and external chat authoring. Provider/data-class approval applies even to a platform-owned model gateway.

## Honest security boundary
Current executable code only evaluates policy and generates plans offline. It cannot contain code. Shared hosting is blocked until runtime, identity, browser, data and adversarial integration tests pass. SpecGuard and LLM review supplement, never replace these controls.

