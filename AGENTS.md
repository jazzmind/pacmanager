# Repository guidance
Read README.md, docs/architecture.md and docs/threat-model.md before changes.
Keep specs as approved intent; do not reverse security requirements from code or weaken tests to make failures pass.
Run node --test and node scripts/check.js. Run PACOS integration when changing the artifact contract.
No model/network access is needed for core tests. Never add live credentials or customer data.
Production enforcement is not implemented: keep scaffold/runtime status explicit.
Use source plus OCI/Score-compatible exports; do not lock apps into opaque generated formats.
Do not publish releases, enable agents or change repository protections as part of ordinary code edits.

