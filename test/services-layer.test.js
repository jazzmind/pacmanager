import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';

// The bundled default services catalog (demo/services/default/catalog.json) declares "postgres"
// and "objects" with prod.projection "local-only" -- OSS ships no default local provisioner or
// prod projection, so binding either one is a real, testable graduation blocker without needing
// pracman's PR-specific catalog. See docs/implementation-status.md's services-layer section.

function sourceTree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-svc-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function harness(t, tokenChar, graduationAdapters) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-svc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = tokenChar.repeat(64);
  const { server } = createDemo({ directory, ownerToken: token, builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, graduationAdapters });
  const call = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
  return { server, call };
}

async function appWithEnvRefs(t, tokenChar, graduationAdapters, envRefs) {
  const { server, call } = harness(t, tokenChar, graduationAdapters);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const src = sourceTree(t, { 'index.html': '<h1>hi</h1>', 'package.json': '{}' });
  const created = await call(base, '/api/apps', { title: 'Service Bound App', brief: 'Exercises the services-layer graduation gate.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src, envRefs });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const appId = created.data.id;
  await call(base, `/api/apps/${appId}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  const published = await call(base, `/api/apps/${appId}/publish`, {});
  assert.equal(published.status, 200, JSON.stringify(published.data));
  return { server, call, base, appId };
}

test('SVC-001 an unknown service kind in envRefs fails closed at declare time, naming the known kinds', async t => {
  const { server, call } = harness(t, 'a', new Map());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const src = sourceTree(t, { 'index.html': '<h1>hi</h1>' });
  const res = await call(base, '/api/apps', { title: 'Bad Ref App', brief: 'Declares a nonexistent service kind.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src, envRefs: { DATABASE_URL: 'not-a-real-service' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Unsupported envRefs resource type/);
  assert.match(res.data.error, /postgres/); // the default catalog's known kinds are named in the error
  server.close();
});

test('SVC-002 graduate_application is blocked when a bound service has no production equivalent (projection local-only)', async t => {
  const graduationAdapters = new Map([['devops-platform', () => Promise.resolve({ status: 'ok', output: {} })]]);
  const { server, call, base, appId } = await appWithEnvRefs(t, 'b', graduationAdapters, { DATABASE_URL: 'postgres' });
  const res = await call(base, `/api/apps/${appId}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /DATABASE_URL/);
  assert.match(res.data.error, /postgres/);
  assert.match(res.data.error, /no production equivalent/);
  assert.match(res.data.error, /allowLocalOnly/);
  server.close();
});

test('SVC-003 allowLocalOnly explicitly overrides the block, and the override is recorded', async t => {
  const received = [];
  const graduationAdapters = new Map([['devops-platform', (files, context, options) => { received.push(options); return Promise.resolve({ status: 'ok', output: { files } }); }]]);
  const { server, call, base, appId } = await appWithEnvRefs(t, 'c', graduationAdapters, { DATABASE_URL: 'postgres' });
  const blocked = await call(base, `/api/apps/${appId}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(blocked.status, 409);
  const res = await call(base, `/api/apps/${appId}/graduate`, { adapter: 'devops-platform', target: 'cloudfront', allowLocalOnly: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(received.length, 1);
  assert.equal(received[0].allowLocalOnly, true);
  server.close();
});

test('SVC-004 an app-tier release with no service bindings graduates cleanly (no blockers, no crash on the app-tier files bug)', async t => {
  const received = [];
  const graduationAdapters = new Map([['devops-platform', (files, context, options) => { received.push({ files, context }); return Promise.resolve({ status: 'ok', output: { files } }); }]]);
  const { server, call, base, appId } = await appWithEnvRefs(t, 'd', graduationAdapters, undefined);
  const res = await call(base, `/api/apps/${appId}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(received.length, 1);
  // An app-tier release is a real repository already on disk -- graduationFiles() (which
  // snapshots template/static-tier standalone exports) must not run for it. See store.js
  // graduateApplication's tier-'app' branch and archive.js's tier check.
  assert.deepEqual(received[0].files, {}, 'app-tier graduation must not call the template/static graduationFiles() snapshot path');
  server.close();
});

test('SVC-005 the assurance dossier surfaces service bindings with their projection and caveat', async t => {
  const { server, call, base, appId } = await appWithEnvRefs(t, 'e', new Map(), { DATABASE_URL: 'postgres' });
  const res = await fetch(`${base}/api/apps/${appId}/assurance`, { headers: { Authorization: 'Bearer ' + 'e'.repeat(64) } });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  const bindings = data.record.facts.serviceBindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].envVar, 'DATABASE_URL');
  assert.equal(bindings[0].kind, 'postgres');
  assert.equal(bindings[0].projection, 'local-only');
  assert.match(bindings[0].caveat, /PAC_SERVICE_CATALOG/);
  server.close();
});
