# ADR 0002: SpecGuard as optional QA plugin
Status: accepted; execution compatibility still to verify

Inspected jazzmind/specguard package.json (specguard-ai 0.1.2), src/core/config.ts, src/core/spec-parser.ts and src/pipelines/matrix.ts on main during scaffold development.
The package exposes specguard and specguard-mcp. Parser uses HTML-comment metadata and H2 sections with H3 scenarios, **Steps:** and **Expected Results:**. Config requires apps and llm fields. Matrix matches test/docs primarily by basename and writes traceability/plans; it is not evidence that tests ran or that every requirement has an assertion.

Use the parser-compatible format and opt-in config here. Match source/spec/test names where feasible; preserve explicit requirement IDs in test names. Independent node:test remains the offline release gate.
Do not automatically reverse approved specs from implementation. Do not allow heal to weaken acceptance/security assertions. Generated changes are proposals on reviewed branches. No production credentials or live browser actions in QA.
The config's onPlanPhase/onPR/heal triggers are disabled. This is configuration, not a security boundary; enforce permissions outside SpecGuard.
No LLM calls or SpecGuard installation were performed as part of initial scaffolding. Inspect and pin a reviewed upstream commit/package before opting in. Config contains an intentionally unset model marker that must be replaced with an approved provider/model.

