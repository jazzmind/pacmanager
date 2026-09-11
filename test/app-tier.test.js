import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';

function sourceTree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-app-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function fixture(t, runtime) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-app-tier-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createDemo({ directory, ownerToken: 'h'.repeat(64), builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, runtime });
}

const call = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'h'.repeat(64) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
const get = (base, path) => fetch(base + path, { headers: { Authorization: 'Bearer ' + 'h'.repeat(64) } }).then(async r => ({ status: r.status, data: await r.json() }));

async function withServer(t) {
  const { server } = fixture(t, null);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('APP-TIER-001 create_application accepts tier app with a real sourcePath', async t => {
  const { server, base } = await withServer(t);
  const src = sourceTree(t, { 'index.html': '<h1>hi</h1>', 'package.json': '{}' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'A referenced source-tree application.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src });
  assert.equal(created.status, 201);
  assert.equal(created.data.config.tier, 'app');
  assert.equal(created.data.config.sourcePath, src);
  assert.equal(created.data.config.dockerfile, 'Dockerfile');
  assert.equal(created.data.config.healthEndpoint, '/health');
  server.close();
});

test('APP-TIER-002 rejects a sourcePath that does not exist, with a clear error', async t => {
  const { server, base } = await withServer(t);
  const res = await call(base, '/api/apps', { title: 'Real App', brief: 'A referenced source-tree application.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: '/nonexistent/path/xyz' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /sourcePath must be a real, existing directory/);
  server.close();
});

test('APP-TIER-003 build digests the tree without going through the Docker/K8s build-worker sandbox', async t => {
  let builderInvoked = false;
  const { server: rawServer } = await (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pac-app-tier-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const server = createDemo({ directory, ownerToken: 'h'.repeat(64), builder: { mode: 'Test compiler', build: async c => { builderInvoked = true; return compile(c); } } }).server;
    return { server };
  })();
  await new Promise(r => rawServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${rawServer.address().port}`;
  const src = sourceTree(t, { 'index.html': '<h1>hi</h1>' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'Digest test only.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src });
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  const view = await get(base, `/api/apps/${created.data.id}`);
  assert.equal(view.data.build.status, 'ready');
  assert.ok(view.data.build.result.sourceDigest);
  assert.equal(view.data.build.result.checks.every(c => c.passed), true);
  assert.equal(builderInvoked, false, 'the app tier must not invoke the Docker/K8s build-worker sandbox — there is nothing untrusted to isolate at this step');
  rawServer.close();
});

test('APP-TIER-004 the source digest changes when a file in the referenced tree changes, and publish carries the new digest', async t => {
  const { server, base } = await withServer(t);
  const src = sourceTree(t, { 'index.html': 'v1' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'Digest change test.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src });
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  const firstDigest = (await get(base, `/api/apps/${created.data.id}`)).data.build.result.sourceDigest;

  writeFileSync(join(src, 'index.html'), 'v2');
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  const secondView = await get(base, `/api/apps/${created.data.id}`);
  assert.notEqual(secondView.data.build.result.sourceDigest, firstDigest);

  await call(base, `/api/apps/${created.data.id}/publish`, {});
  const published = await get(base, `/api/apps/${created.data.id}`);
  assert.equal(published.data.release.number, 1);
  server.close();
});

test('APP-TIER-005 preview returns app-tier metadata, not an attempt to render null HTML', async t => {
  const { server, base } = await withServer(t);
  const src = sourceTree(t, { 'index.html': 'x' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'Preview shape test.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src });
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  const preview = await get(base, `/api/apps/${created.data.id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.tier, 'app');
  assert.match(preview.data.preview, /not available for the app tier/);
  assert.ok(preview.data.sourceDigest);
  server.close();
});

test('APP-TIER-006 the standalone export format refuses an app-tier release with a clear redirect to graduate_application', async t => {
  const { server, base } = await withServer(t);
  const src = sourceTree(t, { 'index.html': 'x' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'Export refusal test.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src });
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call(base, `/api/apps/${created.data.id}/publish`, {});
  const res = await fetch(base + `/api/apps/${created.data.id}/export`, { headers: { Authorization: 'Bearer ' + 'h'.repeat(64) } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /graduate_application/);
  server.close();
});

test('APP-TIER-007 deploy_application passes sourcePath and app-tier fields to the runtime adapter', async t => {
  const calls = [];
  const runtime = {};
  for (const op of ['deploy', 'sync', 'undeploy', 'stop', 'start', 'status', 'list', 'logs', 'health']) {
    runtime[op] = args => { calls.push({ op, args }); return Promise.resolve({ status: 'ok', output: { op } }); };
  }
  const { server } = fixture(t, runtime);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const src = sourceTree(t, { 'index.html': 'x', Dockerfile: 'FROM node:20-alpine' });
  const created = await call(base, '/api/apps', { title: 'Real App', brief: 'Deploy payload test.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: src, port: 4200, pathPrefix: '/real-app', syncCapable: true, envRefs: { DATABASE_URL: 'postgres' } });
  await call(base, `/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call(base, `/api/apps/${created.data.id}/publish`, {});
  await call(base, `/api/apps/${created.data.id}/deploy`, {});
  const deployCall = calls.find(c => c.op === 'deploy');
  assert.equal(deployCall.args.payload.sourcePath, src);
  assert.equal(deployCall.args.payload.port, 4200);
  assert.equal(deployCall.args.payload.pathPrefix, '/real-app');
  assert.equal(deployCall.args.payload.syncCapable, true);
  assert.deepEqual(deployCall.args.payload.envRefs, { DATABASE_URL: 'postgres' });
  assert.equal(deployCall.args.payload.source, undefined, 'app tier must not also send an inline source map');
  server.close();
});
