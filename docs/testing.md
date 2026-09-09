# Test strategy and trust
Unit: strict validation, exact grants, version invalidation, inert plans and graduation caveats.
CLI: valid/invalid commands and deterministic JSON output.
Cross-repository: every PACOS artifact validates against PAC Manager.
Spec checks: IDs/sections/examples. These checks are not proof of assertion completeness.
Future integration: real sandbox escape/lateral access attempts, data role isolation, denied DNS/IPv6/browser traffic, policy-outage fail-closed, approval races and clean backup restore.
Model evals: synthetic prompt injection and conflicting source permissions; keep a held-out set reviewed independently of the generation agent.
CI is offline, no model/GitHub tokens, read-only permissions. Required status checks and protected paths need repository settings configured by maintainers; a workflow alone does not enable protection.

