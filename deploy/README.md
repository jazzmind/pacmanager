# Deployment references
No deploy command is supplied: the current scaffold has no runtime controller, identity service or data provisioner.
security-baseline.yaml is a reference default-deny namespace policy, not a complete installation. Do not grant workload access to edit policies. Real enforcement requires a compatible CNI, sandbox runtime, approved broker routes and adversarial verification.

