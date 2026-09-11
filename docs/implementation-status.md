# Verification record

## Real application generation (this pass)

Added a `tier` field to the application definition (`demo/definition.js`). `tier: 'template'` (the default) is
unchanged from the original bounded demo: four scalar fields interpolated into one fixed HTML shell, no user code.
`tier: 'static'` is new: the caller (Claude via MCP, or the web owner) supplies a real source file map — `index.html`
plus optional `.css`/`.js`/`.json`/`.svg` files — and `compile()` genuinely assembles and serves it. This is the
capability that was previously listed below as "not implemented" ("arbitrary generated application execution"); it
now exists for client-side/static applications specifically. Container/service-tier generated code (a generated app
with its own server-side process) is still not implemented.

The `checks` array for both tiers is now genuinely evaluated, not a hardcoded `passed:true` literal: static-tier
source is validated for path traversal, extension allowlist, file/size caps, `eval`/`new Function`/`document.write`/
`fetch`/`XMLHttpRequest`/`WebSocket`/dynamic `import()` calls, external (`http`/`https`) references, and
`</script`/`</style` breakout sequences — any violation fails the build with a specific reason rather than silently
producing a generic template. The controller's byte-identical build verification (`store.js` `startBuild`) required
no changes: `compileStatic()` is still a pure function of the definition, so the existing deterministic-verification
property — the reason the elaborate Docker/Kubernetes build isolation is meaningful at all — extends unmodified to
generated code.

Generated static apps are served through a real sandbox rather than a decorative one: the response `Content-Security-
Policy` allows script execution only via a `sha256-` hash computed from the exact compiled inline script (verified
byte-for-byte against what a browser would hash), blocks all outbound requests (`connect-src 'none'`), and the
embedding `<iframe>` carries `sandbox="allow-scripts"` — deliberately without `allow-same-origin` — so the generated
document runs with an opaque origin and no access to the parent's cookies or session. `test/generation.test.js`
(GEN-001..005) covers determinism, all six rejection categories, CSP-hash correctness, and a real end-to-end MCP
create → build → preview round trip.

Verified live end-to-end, not just in tests: a real playable canvas-based Pac-Man clone was authored via the actual
MCP tool call path (`create_application`/`update_application` with `tier: 'static'`), built through the real
`docker run --network=none --read-only --cap-drop=ALL …` adapter (after rebuilding `pac-builder:demo` from the
updated `definition.js`/`build-worker.js`), served from `/api/apps/:id/preview`, and rendered headlessly with zero
page errors and correct gameplay (score/lives/collision state changing frame to frame).

MCP client configuration was also broken independently of the above: the on-disk `claude_desktop_config.json` had a
duplicated path segment in `PAC_TOKEN_FILE`, causing `demo/mcp-stdio.js` to crash at module load before any JSON-RPC
exchange (reproduced and confirmed). Fixed the config and hardened the bridge's default token path to resolve
relative to the module rather than the client's cwd, with a readable stderr message instead of a raw stack trace on
failure. The `create_application`/`update_application` MCP tool schemas previously marked every property required
(a schema-generation bug, `Object.keys(properties)`), which would have made the new optional `tier`/`source` fields
mandatory on every call; fixed to take an explicit required-fields list per tool.

PACOS sibling integration (`../pacos`, now checked out beside this repo): **seven** manifests validate and produce
inert plans (previously six) — a `news-briefing` agent was added there, matching the existing per-agent
`agent.json`/`artifact.json`/`instructions.md` pattern. It is a scaffold only: `active: false`,
`network.outbound: 'deny'`, and no capability is bound live. Its instructions require that any imitation of a named
person's writing style be derived only from that person's own supplied writing samples, never assumed from title or
reputation, and require every output to carry an AI-generated / style-imitation label — this is a design decision
that a governance-focused product should encode explicitly, not leave to a single agent's prompt.

Docker was genuinely exercised in this pass, not just claimed: `npm run demo:setup` rebuilt the `pac-builder:demo`
image, a real build ran the static-tier Pac-Man source through the `docker run --network=none …` adapter, and the
previously-never-run `PAC_TEST_DOCKER=1 node --test test/demo-docker.test.js` integration test was executed and
passes (uid 10001, read-only root filesystem, no non-internal network interfaces).

Locally verified with Node.js 24.19.0: **23 tests, 22 passing, 1 skipped** (the Docker integration test above is
skipped by default and only runs with `PAC_TEST_DOCKER=1`; CI runs it). `node scripts/check.js` passes.

## Bounded demo implementation (prior pass)

Living assurance extension. Added structured ARB/readiness/BOM data, automatic published-change propagation, human
decision staleness, MCP prompts/resources/tools, report previews/downloads, release history and reviewed GitHub code
publication. GitHub publishing is tested with an injected API double; a real artifact publication has not been
performed. Reports use HTML/Markdown/JSON. Reference DOCX files were inspected but are not copied into the public
repository. An arcade-inspired logo concept is included at `assets/logo.png`.

Implemented: browser workspace; fixed claims/knowledge templates plus the new static-source tier above;
persistent single-writer JSON store; Docker and Kubernetes build adapters; mock claims; shared notes/uploads;
publish and runnable snapshot export; local setup and Kubernetes deployment generator.

Not executed in this workspace: Kubernetes/EKS resources, browser visual/interaction rehearsal beyond the headless
check above, a live Claude Desktop authoring session (the MCP config is now fixed and manually verified against the
live server, but no full Claude Desktop session was rehearsed end-to-end), or SpecGuard. Kubernetes requires actual
cluster network-policy verification. The tested process builder is explicitly labelled as having no container
isolation.

Not implemented: server-side/service-tier generated application execution, a server-side model-generation lane (no
model endpoint is reachable from this machine — ports 4001/8000/11434 were all checked and are down), remote ChatGPT
OAuth connector, CRDT collaborative documents, vector retrieval, PostgreSQL/MinIO shared-service provisioning, live
API bindings/L7 proxy, PACOS agent execution, production SSO or HA. These limitations are also displayed or
documented in the demo.

## Initial scaffold
Initial scaffold verified locally with Node.js 24.19.0:
- node --test: 11 passing tests, zero failures.
- node scripts/check.js: examples and living-spec references pass.
- PACOS sibling integration: seven manifests validate and produce inert plans.
Node.js 22 is the declared minimum and CI target; local tests were not run on Node.js 22.
No dependencies or models were installed/called. SpecGuard source was inspected but its CLI was not executed.
No sandbox, cloud resource, database, mock/live network provider or authenticated sharing service was deployed.
GitHub CI results are separate from these local results.
