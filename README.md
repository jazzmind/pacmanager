# PAC Manager
Portable Artifact Contract manager — build with your AI, keep control of your software.

An Apache-2.0 open-source project intended to demonstrate interesting AI engineering at Plymouth Rock. No commercial edition, paid governance tier, or insurer-specific core. Organizational endorsement, trademarks and release communications require maintainer approval.

## Status: executable design scaffold
This is **not a secure application host yet**. The CLI validates alpha contracts, produces deterministic deployment plans and exports graduation metadata. The pure policy evaluator tests exact artifact/user/version/binding grants. It does not enforce a network boundary or run generated applications.

No cloud account, model key or npm installation is needed for these commands (Node.js 22+):
```sh
npm test
npm run check
npm run demo
node src/cli.js validate examples/knowledge-hub/artifact.json
node src/cli.js export examples/knowledge-hub/artifact.json
```
Example image digests are placeholders. Do not deploy them.

## What we are building
Business users create applications, agents, knowledge hubs and interactive documents through their existing AI tools. Approved low-risk work can be shared without an IT ticket. Real source, data migrations, service contracts, tests and operational evidence remain exportable as the application grows.

Start with [product](docs/product.md), [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [specifications](specs/README.md), [roadmap](docs/roadmap.md) and [developer guide](docs/development.md).

[SpecGuard](https://github.com/jazzmind/specguard) supplies optional living-spec tooling.
[PACOS](https://github.com/jazzmind/pacos) is the first proposed agent pack: open-source project operations, community support and evidence-backed promotion.

## Repository map
- `src/`: dependency-free contract, policy, planner and CLI reference core.
- `test/`: independent executable acceptance tests.
- `specs/`: living specifications with stable requirement IDs.
- `docs/`: product, architecture, decisions, operations and integration contracts.
- `schemas/`: strict machine-readable alpha artifact schema.
- `examples/`: synthetic artifact contracts.
- `deploy/`: non-deployable security-baseline references.
- `.specguard/`: opt-in QA configuration; no automatic healing.

## Contributions
Useful first contributions include schema/validator parity, a mock capability provider, a constrained runtime adapter, permission-aware knowledge APIs and tested export/import round trips. See [CONTRIBUTING](CONTRIBUTING.md). Maintainers retain authority over security policy and releases.

