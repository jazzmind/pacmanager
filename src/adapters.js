/**
 * Out-of-process plugin envelope (docs/plugins.md "Provider invocation envelope").
 * Pure, dependency-free: no process spawning here. The demo/*-adapter.js modules
 * are the executable I/O layer that sends these envelopes to a child process.
 *
 * requestId/artifactId/releaseDigest/principalId are supplied by the trusted caller;
 * an adapter's *reply* must never be trusted to assert its own identity fields.
 */

/** The ten operations a runtime adapter must support: nine mirrored 1:1 from deploykit's
 * DeployBackend interface so an adapter is a thin translation, not a redesign, plus
 * setAccess (per-app email allowlist — deploykit's PUT /api/v1/access/:app_id) for the
 * "apps shared with me" sharing model. */
export const RUNTIME_CAPABILITIES = ['deploy', 'sync', 'undeploy', 'stop', 'start', 'status', 'list', 'logs', 'health', 'setAccess'];

export const GRADUATION_CAPABILITY = 'graduate';

/** Authoring capability — genuinely new, not the "client transport adapter" type in
 * docs/plugins.md (formerly also called "authoring adapter" there, before the rename this
 * capability prompted — that one describes an MCP/CLI/API mapping onto the control plane, not
 * a generator). This is the first plugin type that turns a brief into real source, via an
 * out-of-process model call — see demo/authoring-adapter.js and
 * docs/implementation-status.md's generation design. */
export const AUTHORING_CAPABILITY = 'authoring';
export const AUTHORING_OPERATIONS = ['generate', 'probe'];
/** The four user-facing artifact kinds an authoring request may name. 'classic' (the legacy
 * template layout) is never generated — it has no source to produce — so it is deliberately
 * excluded here even though demo/definition.js's KINDS includes it for validation purposes. */
export const AUTHORING_KINDS = ['interactive', 'knowledge', 'application', 'auto'];

/** Validate a 'generate' operation's output shape. Pure — no filesystem access; the caller
 * (demo/store.js) is responsible for containment-checking `sourcePath` against the workdir it
 * handed the adapter, since that check requires touching the filesystem (realpathSync) and
 * this module is deliberately kept pure, matching validateResult()'s own contract above. */
export function validateAuthoringOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Authoring output must be an object');
  if (typeof output.kind !== 'string' || !AUTHORING_KINDS.includes(output.kind)) {
    throw new Error(`Authoring output.kind must be one of: ${AUTHORING_KINDS.join(', ')}`);
  }
  if (typeof output.model !== 'string' || !output.model) throw new Error('Authoring output.model is required');
  const hasSource = output.source !== undefined;
  const hasSourcePath = output.sourcePath !== undefined;
  if (hasSource === hasSourcePath) throw new Error('Authoring output must set exactly one of source or sourcePath');
  if (hasSource && (typeof output.source !== 'object' || output.source === null || Array.isArray(output.source))) {
    throw new Error('Authoring output.source must be an object mapping file path to text content');
  }
  if (hasSourcePath && (typeof output.sourcePath !== 'string' || !output.sourcePath)) {
    throw new Error('Authoring output.sourcePath must be a non-empty string');
  }
  if (output.rationale !== undefined && (typeof output.rationale !== 'string' || output.rationale.length > 500)) {
    throw new Error('Authoring output.rationale must be a string of 500 characters or fewer');
  }
  // NOTE: "rationale is required when the request's kind was 'auto'" is enforced by the
  // caller (demo/store.js), not here — this validator only ever sees output.kind, which is
  // the model's *chosen* concrete kind (never the literal 'auto'), so it has no way to know
  // what was originally requested.
  return output;
}

export function envelope({ requestId, artifactId, releaseDigest, principalId, capability, operation, payload, deadline }) {
  if (typeof requestId !== 'string' || !requestId) throw new Error('envelope requestId required');
  if (typeof capability !== 'string' || !capability) throw new Error('envelope capability required');
  if (typeof operation !== 'string' || !operation) throw new Error('envelope operation required');
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) throw new Error('envelope payload must be an object');
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) throw new Error('envelope deadline required (epoch ms)');
  return {
    requestId, artifactId: artifactId ?? null, releaseDigest: releaseDigest ?? null, principalId: principalId ?? null,
    capability, operation, payload: payload ?? {}, deadline,
  };
}

/** Validate an adapter's reply shape. Adapters report success/failure explicitly;
 * a non-zero exit code or invalid JSON is a transport failure, handled by the host. */
export function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Adapter result must be an object');
  if (!['ok', 'error'].includes(result.status)) throw new Error('Adapter result.status must be "ok" or "error"');
  if (result.status === 'error' && typeof result.message !== 'string') throw new Error('Adapter error result requires a message');
  if (result.status === 'ok' && result.output !== undefined && (typeof result.output !== 'object' || result.output === null || Array.isArray(result.output))) {
    throw new Error('Adapter result.output must be an object');
  }
  return result;
}
