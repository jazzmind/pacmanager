# Contract reference
schemas/artifact.schema.json is the machine-readable alpha shape; src/contract.js additionally enforces uniqueness by resource name and capability name/operation.
network defaults MUST be deny. Allowed ingress routes and outbound operations are administrator-issued grants outside the artifact source.
Live binding requests can be declared, but are never automatically approved.
Alpha workload limits: 1–2000 CPU millicores, 1–2048 MiB, TCP port 1–65535. Future resource profiles can extend limits through versioned contracts rather than bypass.
Metadata owners identify accountable groups; they do not grant authority. Names are short DNS-safe identifiers. Images must use SHA-256 digests.

## Version semantics
Unknown fields and unknown versions fail closed. v1alpha1 is unstable; migrations require explicit tooling and approval. Identity, grants and runtime policy must not be inferred from display descriptions.
Canonical digest sorts object keys while preserving array order. It is not RFC 8785 and not a cross-language standard yet; use conformance fixtures before independent implementations. The digest proves content identity, not provenance or authorization.

## Future grant storage
Trusted server issues grant ID, subject, release digest, user/service identity, operation, binding revision, constraints, expiry and revocation state. Grant input to the pure evaluator is trusted caller state. Never accept a posted grant object from an application as authority.

