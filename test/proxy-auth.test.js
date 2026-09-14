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
  assert.deepEqual(principalFromProxyHeaders(r, ENV), { kind: 'user', label: 'alice@plymouthrock.com', email: 'alice@plymouthrock.com', via: 'proxy' });
});

test('PROXY-AUTH-009 an admin email builds an owner-kind principal', () => {
  const r = req({ 'x-pac-proxy-secret': ENV.PAC_TRUSTED_PROXY_SECRET, 'x-forwarded-email': 'wsonnenreich@plymouthrock.com' });
  assert.equal(principalFromProxyHeaders(r, ENV).kind, 'owner');
});

// PROXY-AUTH-010/011: /api/me's authMode must reflect how THIS request actually authenticated,
// not a server-wide setting -- found live: reporting it from process.env.PAC_AUTH_MODE sent an
// owner-token bearer session to /oauth2/sign_out, which 401s because oauth2-proxy isn't running
// in that deployment shape at all.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';

function liveFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-authmode-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'm'.repeat(64);
  const secret = 's'.repeat(32);
  process.env.PAC_AUTH_MODE = 'proxy';
  process.env.PAC_TRUSTED_PROXY_SECRET = secret;
  process.env.ADMIN_EMAILS = 'admin@plymouthrock.com';
  t.after(() => { delete process.env.PAC_AUTH_MODE; delete process.env.PAC_TRUSTED_PROXY_SECRET; delete process.env.ADMIN_EMAILS; });
  const { server } = createDemo({ directory, ownerToken: token, builder: { mode: 'test', build: async c => compile(c) } });
  return { token, secret, server };
}

test('PROXY-AUTH-010 authMode is "local" for a bearer-token session even when PAC_AUTH_MODE=proxy is configured server-wide', async t => {
  const { token, server } = liveFixture(t);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  assert.equal(data.authMode, 'local');
});

test('PROXY-AUTH-011 authMode is "proxy" only for a request that actually authenticated via the trusted header', async t => {
  const { secret, server } = liveFixture(t);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/me`, { headers: { 'X-Pac-Proxy-Secret': secret, 'X-Forwarded-Email': 'admin@plymouthrock.com' } });
  const data = await res.json();
  assert.equal(data.authMode, 'proxy');
});
