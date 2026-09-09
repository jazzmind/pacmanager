import { assertValid, digest } from './contract.js';

/** Pure policy evaluator; grants must come from a trusted server, never the workload. */
export function authorize(artifact, request, grants = [], now = Date.now()) {
  assertValid(artifact);
  const deny = reason => ({ allowed: false, reason });
  if (!request || typeof request !== 'object' || !Number.isFinite(now)) return deny('invalid-request');
  if (!['mock','live'].includes(request.binding)) return deny('invalid-binding');
  const declared = artifact.capabilities.some(c => c.name === request.capability && c.operation === request.operation && c.binding === request.binding);
  if (!declared) return deny('undeclared-capability');
  const grant = Array.isArray(grants) && grants.find(g => g &&
    g.subject === artifact.metadata.name && g.digest === digest(artifact) &&
    g.capability === request.capability && g.operation === request.operation &&
    g.binding === request.binding && g.user === request.user && typeof g.user === 'string' &&
    typeof g.id === 'string' && g.id.length > 0 && g.revoked === false &&
    Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) > now);
  return grant ? { allowed: true, reason: 'explicit-grant', grantId: grant.id } : deny('missing-valid-grant');
}
