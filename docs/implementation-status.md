# Verification record

## Remaining tasks

Broken out in detail because "done" claims above are easy to skim past the gaps. Each item
names the exact file/behavior involved and whether it's blocked on something outside this
repo (a live sandbox, DevOps sign-off, a model endpoint) or just not built yet.

### Blocking the three stated goals (local app → sandbox app → migrate chatprc)

- **R5 — CORRECTED, was stale.** This previously read "Per-app access control does not exist
  at any layer." Re-verified live while doing the platform gap analysis
  (`pracman/docs/gap-analysis.md` §2.5): it now exists. deploykit's
  `sandbox/src/deploykit/proxy/nginx.py` `_acl_block()` generates a real per-app nginx ACL
  from `AppSpec.allowed_emails`, matched against `$http_x_forwarded_email`, and it
  round-trips correctly through a deploykit restart (`service.py:112-123`); `PUT
  /api/v1/access/{app_id}` exists server-side; pacmanager's own runtime adapter already
  calls it via `setAccess`. Remaining work here is verification, not construction — plus one
  real open question the correction surfaced: the ACL trusts an *incoming* header rather than
  nginx's `auth_request` module (`nginx.py`'s own docstring says `auth_request` was tried
  first and doesn't work in this nginx/Docker combination), so the guarantee is sound only
  while oauth2-proxy is unavoidably in front of the app and the app's own port is
  unreachable directly — a network-topology invariant, not a cryptographic one, and it needs
  to be confirmed rather than assumed before "share with specific people" is trusted as a
  security boundary rather than a UX convenience. The shared-`DEPLOYKIT_TOKEN` +
  self-asserted `X-Deploy-User` control-plane concern in the original note is unrelated to
  this and remains accurate: any token holder can still stop/start/undeploy/read logs for
  *any* app at the control-plane layer, independent of the per-app nginx ACL.
- **The export-before-undeploy safety gate has no working path for the app tier.**
  Verified live: `graduationFiles()`/the standalone export route now correctly *refuses* an
  app-tier release ("use graduate_application instead" — see R2 below), which means
  `store.recordExport()` can never be called for an app-tier app, which means
  `undeployApplication`'s "export the current release first" guard can never be satisfied,
  which means **`undeploy_application` is currently unusable for any app-tier app**. Needs
  either a real per-app export mechanism (chatprc's own pattern: `GET /export` with a
  bearer token, called and recorded as evidence — see the chatprc migration section below)
  or a documented bypass for genuinely stateless apps.
- **A real React/Vite app has not been scaffolded yet.** The `app` tier (source digesting,
  referenced-not-embedded storage, deploy-time materialization) is built and proven end to
  end against a minimal static nginx app — but not yet against an actual `npm ci && vite
  build` Dockerfile-based app, which is the actual Goal 1 deliverable. The mechanism is
  proven; the specific app is not built.
- **The agent service (Letta or equivalent) has not been stood up.** Needs a short spike
  (Letta vs Agno vs Goose). Its pgvector prerequisite is now resolved this pass — see the
  new section below — but the service itself is not yet running.
- **Deploying to the sandbox (not just locally) is unimplemented.** `materializeRemote()`
  in the runtime adapter exists and is unit-tested, but has never been run against a real
  SSH tunnel to the actual sandbox host — only against a local fake server.
- **The chatprc import path (R8, "imported" artifact kind) does not exist.** Nothing reads
  `.deploykit/apps.json`/`package.json`/`Dockerfile`/`start.sh` to construct a pacmanager
  artifact from a pre-existing repo. Needed before chatprc (or any existing app) can be
  brought under pacmanager management at all.
- **DevOps sign-off items, unchanged:** CODEOWNERS delegation for `devops-deployments`,
  whether pacmanager may trigger `Deploy Applications` via the Jenkins API vs. a human
  running it, who provisions the "worksite" environment envelope.

### Services layer, brand pack, and pracman repo (this pass)

New PR-specific repo `pracman` (`~/Code/utilities/pracman`, destined for
`prac-innovation/pracman`, not yet pushed) absorbed the former `pacmanager-adapters` repo
(0 commits there — a directory move, not a migration; all 35 tests pass from the new
location at `pracman/adapters/`). It now holds everything PR-specific per the OSS/PR split
table in its README: the runtime + graduation adapters, a brand pack, and the flexible
services catalog.

- **Brand pack (declarative, not a spawned adapter).** `demo/brand.js` loads
  `PAC_BRAND_PACK` (else a bundled neutral default at `demo/brand/default/`, so unbranded
  OSS renders exactly as before), validates fail-fast (unknown keys, non-hex tokens, assets
  that don't exist or escape the pack directory — all four cases tested live), and exposes
  `cssVars()`/`t()`/`assetPath()`/`accentPalette()`. Wired into `demo/server.js` (`/brand.css`,
  `/brand/:asset` routes, `index.html` templating for product name and logo),
  `demo/definition.js` (deduped the accent palette that was previously hardcoded verbatim at
  two call sites), and `demo/assurance.js` (report title, ARB diagram colors). The PR pack
  lives at `pracman/brand/` with the Plymouth Rock Enterprise logo (both fill variants) and
  documents in `BRAND-NOTES.md` that the brand guide has **no color-palette or typography
  section** — the tokens are carried over from `apps/ai-portal`, not guide-derived, pending
  brand-team confirmation. The PR Mark app icon is a placeholder monogram, not extracted from
  the guide's actual artwork — flagged explicitly for replacement before shipping anywhere
  user-facing. Known gap: only 4 of `demo/web/style.css`'s ~50 hex literals were tokenized
  (the ones that are genuinely brand colors, not derived tints); the rest are documented as
  out of scope for this pass rather than silently left.
- **Flexible services layer (R6's prerequisite, generalized).** `demo/services.js` replaces
  the hardcoded `ENV_REF_TYPES = ['postgres','pgvector','objects']` with a loaded catalog
  (`PAC_SERVICE_CATALOG`, else a bundled default of `postgres`/`objects`, both
  `local-only`). Each catalog entry has three faces: `local` (container recipe), `binding`
  (deploykit sentinel token → provisioner result key), and `prod.projection` —
  `native`/`substituted`/`local-only`, a closed vocabulary. The PR catalog
  (`pracman/services/catalog.json`) ships **pgvector** and **litellm** (`native` and
  `substituted` respectively) and a working **mock-api** stub service (`local-only`,
  `pracman/services/mock-api/`); redis, dynamodb-local and sqlite are catalog entries only
  (`implemented:false`).
- **The graduation gate is real and tested (SVC-001 through SVC-005,
  `test/services-layer.test.js`).** `store.js`'s `graduateApplication` now checks every
  `envRefs` binding's projection before invoking the adapter: a `local-only` binding blocks
  with a 409 naming the env var, kind and reason, unless the caller passes
  `allowLocalOnly:true` (recorded in the audit trail). `demo/assurance.js` surfaces every
  binding with its projection and caveat as a dossier fact, so the surprise is visible at
  declare/build time, not just at graduation.
- **Found and fixed live: `graduateApplication` was unusable for any app-tier app.** It
  unconditionally called `graduationFiles()`, which by design throws for `tier:'app'`
  ("use graduate_application instead" — the very function that was calling it). Fixed:
  app-tier releases now pass an empty file map to the graduation adapter instead (there is
  nothing for the template/static snapshot format to capture; the adapter's `files` param is
  optional and only seeds an existing `package.json`). Caught by SVC-004, which would have
  failed against the pre-fix code.
- **pgvector prerequisite (previously listed as an open blocker) — resolved.**
  `bootstrap-sandbox.sh`'s Postgres image is now `${DEPLOYKIT_PG_IMAGE:-pgvector/pgvector:pg16}`
  instead of the hardcoded `postgres:16-alpine`. This is also documented to fix
  `deploykit webui-bootstrap` (previously broken: it posts `enable_pgvector:True` against an
  image lacking the extension, which raises, turns into a 500, and aborts before the admin
  seed) and to unblock webui's shipped-but-disabled `/api/search` (currently 501). Not yet
  re-run against a live re-bootstrap to confirm the swap end-to-end — the deploykit pytest
  suite (12 tests, all still passing) doesn't cover bootstrap-sandbox.sh at all.
- **Not done this pass, left for later:** deploykit's deeper services-layer generalization
  (a real `ServiceProvider` ABC mirroring `AuthProvider`, an importable `_PROVISIONERS`
  registry instead of one rebuilt per deploy, a uniform `extra["services"]` resource ledger
  so store-provisioned resources actually get deprovisioned on undeploy, new
  `{{SANDBOX_LITELLM_URL}}`/`{{SANDBOX_MOCKAPI_URL}}` sentinels, health gating that turns
  today's warn-only waits into real failures). All catalogued in the plan file with exact
  file/line references; none of it blocks what shipped this pass.

### Built and verified this pass, with a known limitation each

- **Runtime adapter (R1) — done, tested against a local fake server, not yet a live sandbox.**
  `pracman/adapters/runtime/deploykit/`: `AppSpec` mapping, source materialization
  (inline static-tier write, app-tier **symlink** so live edits need no re-materialization),
  the sync-then-fallback-to-deploy optimization deploykit's own client convention documents,
  and the full REST+SSE client. 34 tests, including 5 real subprocess/HTTP/SSE round trips.
  **Found and fixed live, not by inspection:** `demo/adapter-host.js` stripped a spawned
  adapter's environment down to `PATH`/`HOME` — copying `builders.js`'s untrusted-build-worker
  hardening, which is the wrong trust model for an operator-configured plugin that needs to
  read its own `DEPLOYKIT_TOKEN`/`DEPLOYKIT_API_URL` from the environment. A real deploy
  failed silently on this before the fix; now adapters inherit the full parent environment.
  Symlink-based materialization also only works if the deploykit *container's* own bind
  mount is broad enough to see wherever the real source lives (verified live: a symlink
  into `/tmp` was invisible from inside the container even though the host Docker daemon
  could see it fine) — document this as a deployment-topology requirement, not a code bug.
- **`app` tier + provenance (R2/R3) — done and tested (16 tests), verified with a real local
  deploy.** `demo/tree-digest.js` (deterministic sorted-path/per-file-sha256 digest,
  practical exclude list matching deploykit's own rsync excludes — not a full `.gitignore`
  parser, a documented limitation) + `definition.js`'s `app` tier (referenced `sourcePath`,
  validated to exist at `create_application` time, not deferred to build) + `store.js`
  skipping the Docker/K8s build-worker sandbox entirely for this tier (there's nothing
  untrusted to isolate at the digest step — the real image build happens later, inside
  deploykit) + the preview/export routes refusing to treat a `null`-html app-tier release
  as if it were a static-tier one.
- **deploykit local-mode nginx bugs (R4, partial) — the two verified bugs are fixed and
  tested; wrote deploykit's first-ever test suite (12 tests) to prove it.**
  `sandbox/src/deploykit/proxy/nginx.py`: a missing `nginx` binary raised an uncaught
  `FileNotFoundError` that escaped `add_route()`'s own `except RuntimeError` handling
  (container builds/runs/passes health checks, deploy still reports failure, store row
  stranded); `_reload()`'s `systemctl` attempt raised the same uncaught exception on macOS
  *before* its own `nginx -s reload` fallback could run. Both fixed by normalizing a missing
  binary in `_run()`. Added `DEPLOYKIT_READINESS_ENABLED` (default on) so a local instance
  isn't forced to spawn `claude -p` against a `webui` Postgres database it has no reason to
  provision. **Not done:** the containerized-nginx + host-port unrepresented combination
  (no `host.docker.internal` option) — moot as long as full docker-network mode is used, as
  verified live.
- **Graduation exporter (Phase 3, prior pass) — unchanged, still green**: `workload.yml` /
  `image.yml` / `Jenkinsfile` generation for `cloudfront`/`eks`/`lambda`, validated against
  both vendored schemas and the real `orchestrator validate`/`generate` CLI.

### Verified live this pass (not just unit-tested)

A real local deploykit stack (`deploykit`, `deploykit-nginx`, `deploykit-postgres` — found
already bootstrapped locally from prior exploration, rebuilt with this pass's fixes) took a
pacmanager `app`-tier release end to end: `create_application` (real `sourcePath`) →
`build_application` (tree digest, no sandbox) → `publish_application` → `deploy_application`
→ the runtime adapter → deploykit's real `POST /api/v1/deploy` → a real `docker build`/
`docker run` of an nginx-based test app → a real nginx route → **the app's actual HTML,
served through the full chain at `http://localhost/<path-prefix>/`**. `deployment_status`
correctly reported `running` with the real container id and URL throughout.

## Real AI-driven generation (this pass)

Not to be confused with the "Real application generation" section directly below, from an
earlier pass: that one lets a caller (a human, or Claude via MCP) *hand-author* real source
and have it genuinely compiled/served — no model involved. This pass adds what was still
missing after that: an actual model call that turns a plain-English brief into that source,
because the honest state before this pass was that pacmanager's own browser form asked for a
brief, then silently ignored it and served the bounded four-field template. Verified live: a
"Tapper Clone" brief produced 1,371 bytes with zero `<script>` — a claims-workbench layout
with the title pasted in.

Four real, live-reported problems drove this pass, not a speculative wishlist:
1. The browser form made the user pick a **template** (`claims`/`knowledge`), which changes
   exactly one word of output (`demo/definition.js`'s eyebrow label) and is required on every
   tier including ones where it means nothing.
2. **Nothing was generated.** No model integration existed anywhere in the repo — no provider
   env var was ever read.
3. Branding: the sidebar was pale sage and the logo was rendered in white on light backgrounds
   (~1.1:1 contrast, effectively invisible) — see "Branding and sign-out" below.
4. Sign-out 404'd: `authMode` was reported from the server's configured mode, not from how the
   requesting principal actually authenticated.

**Artifact kinds replace the template choice.** `demo/definition.js` adds
`kind: 'interactive' | 'knowledge' | 'application' | 'auto'` (plus `'classic'` for the legacy
template layout, never offered in the browser picker but MCP-reachable forever) and a new
tier, `'intent'` — a definition that has been created but not yet generated. `compile()`
explicitly refuses a `tier: 'intent'` definition rather than silently falling back to a
template; there is no template to fall back to. This is what makes "silently produced the
wrong thing" structurally impossible rather than merely discouraged. Migration is dual-accept,
absent-means-classic: `kind` is optional, and when absent, `template` behaves exactly as
before with a byte-identical `sourceDigest` (verified via `git stash` before/after comparison
against the pre-change commit, pinned as regression hashes in `test/kind.test.js`) — no
existing record needed rewriting.

**Generation is a separate, earlier lifecycle stage from build, not a branch inside it.**
`startBuild()`'s entire contract is "run the builder, then require byte-identical
re-derivation" (the reason the build sandbox is meaningful at all) — a nondeterministic model
call has no place inside that. `Store.startGeneration()` (`demo/store.js`) calls the
authoring adapter, validates its output against the exact same safety gate a hand-authored
source map must pass (`sourceIssues()` — the prompt and the gate read the same constants,
`SOURCE_LIMITS`/`FORBIDDEN_LABELS`, so they cannot drift apart), and on success writes the
result through `definition()` — never by hand-merging fields — bumping `app.revision` exactly
once. From that point on the existing build/publish/deploy/graduate paths run unchanged,
because by the time `startBuild()` runs, `config.source` is frozen literal data. Generation
gets its own state field, `app.generation`, deliberately not reusing `app.build` — build and
generation have incompatible contracts, and `app.build.status==='ready'` with no result would
corrupt both `draw()` and the publish guard.

The retry loop (bounded at `PAC_AUTHORING_MAX_ATTEMPTS`, default 3, hard ceiling 5) lives in
the host, not the adapter — one adapter invocation is one attempt, and the host feeds the
exact rejection (safety-gate issues, or a malformed reply) back as the next attempt's
`previousAttempt`. An adapter-reported failure is retried only when it marks itself
`retriable` (the model's own mistake — malformed output) versus not (a broken credential or
dead gateway, where retrying the same request three times just wastes the budget). An
`application`-kind artifact's `sourcePath` is `realpathSync`-contained against the `workdir`
the host handed the adapter; a containment violation is a hard failure with no retry, since
that's an adapter bug or an attack, not a model mistake. `GET /api/me` exposes a cached
authoring-availability probe (`authoringStatus()`, default 5-minute TTL, stale-but-return with
a background refresh) so a page load never blocks on a live model call, and the browser can
say "no AI connected" before a brief is even written.

The out-of-process adapter (`pracman/adapters/authoring/` — Plymouth Rock-specific, kept out
of this OSS repo) calls the sandbox LiteLLM proxy first, falling back to a direct Anthropic or
OpenAI key if LiteLLM is unreachable or misconfigured. Two real, live-only bugs were found and
fixed getting an actual model to complete this loop (neither was visible in any unit test,
because both required a real gateway and a real prompt of realistic length):
- `claude-sonnet-5` through this gateway defaults to extended thinking, and with a
  realistic-length prompt the entire token budget could be consumed by an empty thinking
  block before any answer text — HTTP 200, `finish_reason: "length"`, `message.content`
  structurally empty, no error status anywhere. Fixed by explicitly disabling thinking on the
  request (it buys nothing for a fully-specified code-generation prompt).
- Asking the model to JSON-escape multi-line HTML/CSS/JS into a JSON string value failed
  reliably (3 for 3 on a real generation, including retries, because the format itself was
  the problem) — the model kept embedding literal unescaped newlines inside JSON string
  values, which `JSON.parse` correctly rejects. Fixed by replacing the output format entirely
  with a delimited plain-text scheme (`@@PAC_FILE: path@@` ... `@@PAC_END@@`) where file
  content is copied verbatim, with no escaping step to get wrong.

**Verified live end-to-end, through the actual browser-facing API, not just against a fake
adapter in tests:** the exact brief from the original complaint — "a clone of the arcade game
Tapper, insurance themed... slide insurance claims down the counter" — produced a real 11.7KB
canvas game (`serveClaim`, `spawnCustomer`, `gainScore`, `loseLife`, a `requestAnimationFrame`
loop, real keyboard handling) through `claude-sonnet-5` via the real sandbox LiteLLM proxy,
which then built, byte-verified, and rendered correctly. `demo/web/ui.js` chains this
automatically: saving a kind-based brief calls `generate`, and once generation lands, `build`
fires on its own — describing an app now produces a working preview in one motion, with the
existing 2-second poll loop surfacing generation progress in the same log panel build activity
already used.

Test counts: `test/kind.test.js` (10), `test/authoring-adapter.test.js` (5, against a real
spawned process), `test/generation-store.test.js` (12, against an in-process fake adapter that
scripts exact response sequences), `test/generation-server.test.js` (6, against a real
listening HTTP server, including the full describe→generate→build→preview chain). Separately,
`pracman/adapters` (Plymouth Rock-specific, not in this repo): 70 tests for the actual
model-calling adapter (provider fallback, prompt, the delimited-format parser, scaffolding,
and the full CLI process end-to-end against a fake LiteLLM server).

Not done in this pass: the "knowledge" artifact kind's agent-backed Q&A (needs Letta + pgvector
— see "The agent service" in Remaining tasks above, still not stood up) and the remainder of
the branding re-theme (`demo/web/style.css` still has ~45 bare hex literals beyond the four
tokenized for the logo/sign-out fix; fonts are still not self-hosted; see "Branding and
sign-out" below for what *was* fixed this pass).

## Branding and sign-out (this pass)

Two of the four live-reported problems that drove this pass (see above) were unrelated to
generation and fixed first, independently, since both were small and high-annoyance:

- **Sign-out 404'd.** `GET /api/me`'s `authMode` was derived from the server's *configured*
  auth mode (`process.env.PAC_AUTH_MODE==='proxy'`), not from how the requesting principal
  actually authenticated — so an owner-token session behind a proxy-fronted deployment got
  sent to `/oauth2/sign_out`, which 404s because oauth2-proxy isn't in that request's path at
  all. Fixed by tagging the principal itself (`principalFromProxyHeaders()` now returns
  `via: 'proxy'`) and deriving `authMode` per-request from that tag, not from the server-wide
  setting. `test/proxy-auth.test.js` (PROXY-AUTH-010/011) proves this with real HTTP
  round-trips, not just a unit check of the derivation function.
- **The logo was invisible.** The server hardcoded the light-background surfaces (login page,
  sidebar) to `/brand/logo` — a white asset at ~1.1:1 contrast against both. Pointed both
  markers at `/brand/logoMono` instead (the pack's blue variant, which nothing had been
  consuming). Deliberately not "fixed" with a CSS recolor filter — the brand pack's
  `lint.forbidLogoRecolor` rule exists specifically to prevent that.

Not done in this pass: the remaining ~45 bare hex literals in `demo/web/style.css` (the pale
sage sidebar being the most visible), self-hosted fonts (`--pac-font-sans`/
`--pac-font-display` currently have no real consumer path), a favicon link, and deciding the
dead `{{PAC_PRODUCT_TAGLINE}}` substitution's fate.

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

Locally verified with Node.js 24.19.0: **71 tests, 70 passing, 1 skipped** (the Docker integration test above is
skipped by default and only runs with `PAC_TEST_DOCKER=1`; CI runs it). `node scripts/check.js` passes. This count
now also includes the plugin-adapter, contract v1alpha2, app-tier and tree-digest tests added in the platform-
integration pass above; see that section for what they cover.

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
