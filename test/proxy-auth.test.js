import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKind, principalFromProxyHeaders } from '../demo/proxy-auth.js';

const ENV = { PAC_AUTH_MODE: 'proxy', PAC_TRUSTED_PROXY_SECRET: 's'.repeat(32), ADMIN_EMAILS: 'wsonnenreich@plymouthrock.com', APPROVED_DOMAINS: 'plymouthrock.com' };
const req = (headers) => ({ headers });

test('PROXY-AUTH-001 resolveKind is case-insensitive for ADMIN_EMAILS (a real production list has mixed case)', () => {
  assert.equal(resolveKind('WSonnenreich@PlymouthRock.com', ENV), 'owner');
  assert.equal(resolveKind('wsonnenreich@plymouthrock.com', ENV), 'owner');
});

test('PROXY-AUTH-002 resolveKind gives a non-admin approved-domain email the user kind', () => {
  assert.equal(resolveKind('alice@plymouthrock.com', ENV), 'user');
});

test('PROXY-AUTH-003 principalFromProxyHeaders returns null when PAC_AUTH_MODE is not "proxy"', () => {
  const r = req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET, 'x-forwarded-email': 'alice@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, { ...ENV, PAC_AUTH_MODE: undefined }), null);
});

test('PROXY-AUTH-004 a mismatched shared secret fails closed (null), even with a valid-looking email header', () => {
  const r = req({ 'x-pac-proxy-secret': 'wrong-secret-wrong-secret-wrong', 'x-forwarded-email': 'alice@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, ENV), null);
});

test('PROXY-AUTH-005 a missing shared secret fails closed', () => {
  const r = req({ 'x-forwarded-email': 'alice@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, ENV), null);
});

test('PROXY-AUTH-006 an unconfigured (too-short) PAC_TRUSTED_PROXY_SECRET fails closed rather than accepting a weak secret', () => {
  const r = req({ 'x-pac-proxy-secret': 'short', 'x-forwarded-email': 'alice@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, { ...ENV, PAC_TRUSTED_PROXY_SECRET: 'short' }), null);
});

test('PROXY-AUTH-007 a correct secret with a missing/malformed email header fails closed', () => {
  assert.equal(principalFromProxyHeaders(req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET }), ENV), null);
  assert.equal(principalFromProxyHeaders(req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET, 'x-forwarded-email': 'not-an-email' }), ENV), null);
});

test('PROXY-AUTH-008 a correct secret and a real email builds the expected principal', () => {
  const r = req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET, 'x-forwarded-email': 'Alice@PlymouthRock.com' });
  assert.deepEqual(principalFromProxyHeaders(r, ENV), { kind: 'user', label: 'alice@plymouthrock.com', email: 'alice@plymouthrock.com' });
});

test('PROXY-AUTH-009 an admin email builds an owner-kind principal', () => {
  const r = req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET, 'x-forwarded-email': 'wsonnenreich@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, ENV).kind, 'owner');
});
