# ADR 0001: portable core before runtime platform
Status: accepted for scaffold

Use a small dependency-free Node reference core, ordinary source and OCI images. Use Score for workload portability and a separate PAC security contract. Keep the core independent of Kubernetes, model providers and any one agent framework.
Why: faster contribution and offline tests; importing the project must not require a cluster or model key.
Consequence: alpha does not host apps. A real sandbox adapter, data plane and authenticated control API are separate milestones.

