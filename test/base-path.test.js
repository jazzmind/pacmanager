import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

// The studio behind a shared nginx at /pac/: it must answer with or without the prefix on the wire
// (nginx may or may not strip it), and everything it emits must carry the prefix.

async function studio(t, basePath = '/pac', env = {}) {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  const directory = mkdtempSync(join(tmpdir(), 'pac-base-')), ownerToken = randomBytes(32).toString('hex');
  const { server } = createDemo({ directory, ownerToken, builder: createBuilder('process'), basePath, origin: 'http://studio.test' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return { url: p => `http://127.0.0.1:${port}${p}`, ownerToken };
}

test('BASE-001 /pac redirects to /pac/ and keeps the query', async t => {
  const { url } = await studio(t);
  const r = await fetch(url('/pac?app=abc'), { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/pac/?app=abc');
});

test('BASE-002 the page points every asset at the prefix and tells the front end its base', async t => {
  const { url } = await studio(t);
  const html = await (await fetch(url('/pac/'))).text();
  assert.match(html, /<meta name="pac-base" content="\/pac">/);
  assert.match(html, /href="\/pac\/style\.css"/);
  assert.match(html, /src="\/pac\/ui\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\/(?!pac\/)[a-z]/, 'no root-absolute asset left over');
  const admin = await (await fetch(url('/pac/admin.html'))).text();
  assert.match(admin, /href="\/pac\/"/);
  assert.match(admin, /src="\/pac\/admin\.js"/);
});

test('BASE-003 works whether or not nginx strips the prefix', async t => {
  const { url } = await studio(t);
  for (const p of ['/pac/health', '/health']) assert.equal((await fetch(url(p))).status, 200, p);
  assert.equal((await fetch(url('/pac/style.css'))).status, 200);
  assert.equal((await fetch(url('/style.css'))).status, 200);
});

test('BASE-004 the session cookie is scoped to the prefix, not the whole host', async t => {
  const { url, ownerToken } = await studio(t);
  const r = await fetch(url('/pac/api/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ownerToken }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /Path=\/pac\/;/);
});

test('BASE-005 links the server emits carry the prefix (invite URLs, MCP urls)', async t => {
  const { url, ownerToken } = await studio(t);
  const H = { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json' };
  const made = await (await fetch(url('/pac/api/apps'), { method: 'POST', headers: H, body: JSON.stringify({ title: 'Base Path', brief: 'checks emitted links', template: 'claims', accent: 'teal' }) })).json();
  const inv = await (await fetch(url(`/pac/api/apps/${made.id}/invite`), { method: 'POST', headers: H, body: JSON.stringify({ label: 'Colleague' }) })).json();
  assert.match(inv.url, /^http:\/\/studio\.test\/pac\/\?app=/);
});

test('BASE-006 a bad base path is refused at startup; PAC_PUBLIC_ORIGINS adds origin aliases (origin only)', async t => {
  assert.throws(() => createDemo({ directory: tmpdir(), ownerToken: 'x'.repeat(40), builder: createBuilder('process'), basePath: 'pac' }), /PAC_BASE_PATH/);
  const { url } = await studio(t, '/pac', { PAC_PUBLIC_ORIGINS: 'https://alias.test/' });
  const r = await fetch(url('/pac/api/session'), { method: 'POST', headers: { Origin: 'https://alias.test', 'Content-Type': 'application/json' }, body: '{"token":"nope"}' });
  assert.notEqual(r.status, 403, 'alias origin accepted');
  const bad = await fetch(url('/pac/api/session'), { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 403);
});
