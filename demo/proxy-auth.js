/** Trusted-header identity, for when pacmanager sits behind an authenticating reverse proxy
 * (deploykit's nginx, fronted by oauth2-proxy in reverse-proxy mode — see deploykit's
 * bootstrap-sandbox.sh and docs/implementation-status.md). Greenfield and must fail closed:
 * nothing in this codebase previously read any X-Forwarded-* header or had a proxy-trust
 * notion at all, so an unguarded header read would let any client that can reach this process
 * simply assert an identity. Two independent gates, both required:
 *   1. PAC_AUTH_MODE must be exactly 'proxy' (opt-in; default behavior — bearer token + cookie
 *      session — is unchanged otherwise).
 *   2. The request must carry PAC_TRUSTED_PROXY_SECRET's value on X-Pac-Proxy-Secret — a
 *      shared secret only the fronting nginx knows, set via proxy_set_header. The container
 *      publishes no host port (only nginx can reach it on deploykit-net), so this is
 *      defense-in-depth, not the only guard — same reasoning as pacmanager itself trusting
 *      X-Forwarded-Email only from a network position nothing else can reach.
 */
import { timingSafeEqual } from 'node:crypto';

const equalConstantTime = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function commaList(value) {
  return (value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Mirrors apps/ai-portal/lib/auth.ts's resolveRoleAndStatus exactly (comma-split, trim,
 * lowercase, filter Boolean) — the established PR convention for ADMIN_EMAILS/APPROVED_DOMAINS.
 * Lowercasing is not cosmetic: production ADMIN_EMAILS lists have appeared with mixed case
 * (e.g. "WSonnenreich@plymouthrock.com"); a case-sensitive compare silently locks the admin out. */
export function resolveKind(email, env = process.env) {
  const normalized = (email || '').trim().toLowerCase();
  const domain = normalized.split('@')[1] || '';
  const adminEmails = commaList(env.ADMIN_EMAILS);
  const approvedDomains = commaList(env.APPROVED_DOMAINS);
  if (adminEmails.includes(normalized)) return 'owner';
  if (approvedDomains.includes(domain)) return 'user';
  return 'user';
}

/** Returns a principal derived from the trusted proxy headers, or null if proxy-mode auth
 * isn't active, the shared secret doesn't match, or there's no email to build an identity
 * from. Never throws — an absent/invalid header must fall through to the existing
 * bearer/cookie path, not break it. */
export function principalFromProxyHeaders(req, env = process.env) {
  if (env.PAC_AUTH_MODE !== 'proxy') return null;
  const configuredSecret = env.PAC_TRUSTED_PROXY_SECRET;
  if (!configuredSecret || configuredSecret.length < 16) return null;
  const suppliedSecret = req.headers['x-pac-proxy-secret'];
  if (!equalConstantTime(suppliedSecret, configuredSecret)) return null;
  const email = req.headers['x-forwarded-email'];
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const normalized = email.trim().toLowerCase();
  // `via:'proxy'` marks this principal as having genuinely come from the trusted-header path
  // (as opposed to the bearer-token or cookie-session paths), so the UI can tell whether
  // sign-out should hit /oauth2/sign_out (only reachable when oauth2-proxy actually sits in
  // front) or the local /api/logout -- see server.js's /api/me handler. Found live: reporting
  // authMode from server-wide config rather than per-principal sent an owner-token session
  // to /oauth2/sign_out, which 401s because oauth2-proxy isn't running in that deployment.
  return { kind: resolveKind(normalized, env), label: normalized, email: normalized, via: 'proxy' };
}
