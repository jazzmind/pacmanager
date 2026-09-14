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
