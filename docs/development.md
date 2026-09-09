# Development
Node.js 22+; no dependencies for core.
Run npm test, npm run check and npm run demo from repo root.
CLI export prints JSON; use it as metadata for an exporter, not a ready deployment.
Tests are independent of LLM services and GitHub credentials. No generated code executes.

## SpecGuard (optional)
Review docs/adr/0002-specguard.md. Use a reviewed/pinned specguard-ai build; configure provider/model and secret injection locally, then run specguard status or specguard matrix from repo root. Matrix creates files and may draft plans. Never install an unreviewed lookalike npm package named specguard.
Generated specs, tests and docs need ordinary review. Do not run heal/reverse as release gates.
The local check validates examples, spec structure and requirement references; it does not replace SpecGuard or assert feature completion.

## Integration test strategy
PACOS as sibling checkout: from pacos run npm run integration.
Runtime adapters must later test deny rules against actual processes/networks, not just manifests.

