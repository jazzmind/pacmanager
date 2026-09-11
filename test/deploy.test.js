import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';

const staticConfig = { title: 'Deploy Demo', brief: 'Exercises the runtime adapter deploy/undeploy wiring.', template: 'knowledge', accent: 'blue', tier: 'static',
  source: { 'index.html': '<div>hi</div>' } };

function fakeRuntime(calls) {
  const record = (op, args) => { calls.push({ op, args }); return { status: 'ok', output: { op } }; };
  const api = {};
  for (const op of ['deploy', 'sync', 'undeploy', 'stop', 'start', 'status', 'list', 'logs', 'health']) api[op] = args => Promise.resolve(record(op, args));
  return api;
}

function fixture(t, runtime) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-deploy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createDemo({ directory, ownerToken: 'd'.repeat(64), builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, runtime });
}

const call = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'd'.repeat(64) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
const get = (base, path) => fetch(base + path, { headers: { Authorization: 'Bearer ' + 'd'.repeat(64) } }).then(async r => ({ status: r.status, data: await r.json() }));

async function published(t, runtime) {
  const { server } = fixture(t, runtime);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await call(base, '/api/apps', staticConfig);
  const appId = created.data.id;
  await call(base, `/api/apps/${appId}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call(base, `/api/apps/${appId}/publish`, {});
  return { server, base, appId };
}

test('DEPLOY-001 deploy is refused with a clear error when no runtime adapter is configured', async t => {
  const { server, base, appId } = await published(t, null);
  const res = await call(base, `/api/apps/${appId}/deploy`, {});
  assert.equal(res.status, 501);
  assert.match(res.data.error, /No runtime adapter configured/);
  server.close();
});

test('DEPLOY-002 deploy is refused before the app is published', async t => {
  const calls = [];
  const { server } = fixture(t, fakeRuntime(calls));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await call(base, '/api/apps', staticConfig);
  const res = await call(base, `/api/apps/${created.data.id}/deploy`, {});
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Publish/);
  assert.equal(calls.length, 0, 'the adapter must not be invoked when the precondition fails');
  server.close();
});

test('DEPLOY-003 deploy calls the runtime adapter with release identity and records a deployment', async t => {
  const calls = [];
  const { server, base, appId } = await published(t, fakeRuntime(calls));
  const res = await call(base, `/api/apps/${appId}/deploy`, {});
  assert.equal(res.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'deploy');
  assert.equal(calls[0].args.artifactId, appId);
  assert.ok(calls[0].args.releaseDigest, 'release digest must be passed to the adapter');
  assert.equal(calls[0].args.payload.tier, 'static');
  assert.deepEqual(calls[0].args.payload.source, staticConfig.source);
  const view = await get(base, `/api/apps/${appId}`);
  assert.equal(view.data.deployments.length, 1);
  assert.equal(view.data.deployments[0].status, 'ok');
  server.close();
});

test('DEPLOY-004 deployment-status and deployment-logs proxy through the adapter', async t => {
  const calls = [];
  const { server, base, appId } = await published(t, fakeRuntime(calls));
  const status = await get(base, `/api/apps/${appId}/deployment-status`);
  assert.equal(status.status, 200);
  assert.equal(status.data.op, 'status');
  const logs = await get(base, `/api/apps/${appId}/deployment-logs?tail=50`);
  assert.equal(logs.status, 200);
  assert.equal(calls.find(c => c.op === 'logs').args.payload.tail, 50);
  server.close();
});

test('DEPLOY-005 undeploy is refused until the current release has been exported', async t => {
  const calls = [];
  const { server, base, appId } = await published(t, fakeRuntime(calls));
  const refused = await call(base, `/api/apps/${appId}/undeploy`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /[Ee]xport/);
  assert.equal(calls.filter(c => c.op === 'undeploy').length, 0);
  await fetch(base + `/api/apps/${appId}/export`, { headers: { Authorization: 'Bearer ' + 'd'.repeat(64) } });
  const allowed = await call(base, `/api/apps/${appId}/undeploy`, {});
  assert.equal(allowed.status, 200);
  assert.equal(calls.filter(c => c.op === 'undeploy').length, 1);
  server.close();
});

test('DEPLOY-006 undeploy is refused again after a new release makes the prior export stale', async t => {
  const calls = [];
  const { server, base, appId } = await published(t, fakeRuntime(calls));
  await fetch(base + `/api/apps/${appId}/export`, { headers: { Authorization: 'Bearer ' + 'd'.repeat(64) } });
  await call(base, `/api/apps/${appId}/definition`, { config: { ...staticConfig, title: 'Deploy Demo v2' }, revision: 1 });
  await call(base, `/api/apps/${appId}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call(base, `/api/apps/${appId}/publish`, {});
  const res = await call(base, `/api/apps/${appId}/undeploy`, {});
  assert.equal(res.status, 409, 'an export of an older release must not authorize undeploying a newer one');
  server.close();
});

test('DEPLOY-007 the MCP tool surface exercises the same deploy/status/logs/undeploy path', async t => {
  const calls = [];
  const { server, base, appId } = await published(t, fakeRuntime(calls));
  const mcp = (name, args) => call(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const deployed = await mcp('deploy_application', { id: appId });
  assert.ok(!deployed.data.result.isError);
  const status = await mcp('deployment_status', { id: appId });
  assert.ok(!status.data.result.isError);
  const logs = await mcp('deployment_logs', { id: appId, tail: 25 });
  assert.ok(!logs.data.result.isError);
  const undeployBlocked = await mcp('undeploy_application', { id: appId });
  assert.ok(undeployBlocked.data.result.isError);
  assert.match(undeployBlocked.data.result.content[0].text, /[Ee]xport/);
  server.close();
});

test('DEPLOY-008 graduate_application is refused with a clear error when the named adapter is not configured', async t => {
  const { server, base, appId } = await published(t, null);
  const res = await call(base, `/api/apps/${appId}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(res.status, 501);
  assert.match(res.data.error, /No graduation adapter named/);
  server.close();
});

test('DEPLOY-009 graduate_application invokes the named adapter with the release\'s graduation files and options', async t => {
  const received = [];
  const graduationAdapters = new Map([['devops-platform', (files, context, options) => {
    received.push({ files, context, options });
    return Promise.resolve({ status: 'ok', output: { files: { ...files, 'Jenkinsfile': 'fake' }, workload: { path: 'x/workload.yml', validation: { valid: true, errors: [] } } } });
  }]]);
  const directory = mkdtempSync(join(tmpdir(), 'pac-graduate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { server } = createDemo({ directory, ownerToken: 'e'.repeat(64), builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, graduationAdapters });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call2 = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'e'.repeat(64) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
  const created = await call2('/api/apps', staticConfig);
  await call2(`/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call2(`/api/apps/${created.data.id}/publish`, {});
  const res = await call2(`/api/apps/${created.data.id}/graduate`, { adapter: 'devops-platform', target: 'cloudfront', team: 'innovation' });
  assert.equal(res.status, 200);
  assert.equal(res.data.workload.path, 'x/workload.yml');
  assert.equal(received.length, 1);
  assert.equal(received[0].context.artifactId, created.data.id);
  assert.equal(received[0].options.target, 'cloudfront');
  assert.equal(received[0].options.team, 'innovation');
  assert.ok(received[0].files['index.html'], 'graduation files must include the app source');
  server.close();
});

test('DEPLOY-010 graduate_application refuses to run before the app is published', async t => {
  const graduationAdapters = new Map([['devops-platform', () => Promise.resolve({ status: 'ok', output: {} })]]);
  const directory = mkdtempSync(join(tmpdir(), 'pac-graduate-unpublished-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { server } = createDemo({ directory, ownerToken: 'f'.repeat(64), builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, graduationAdapters });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call2 = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'f'.repeat(64) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
  const created = await call2('/api/apps', staticConfig);
  const res = await call2(`/api/apps/${created.data.id}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(res.status, 409);
  server.close();
});

test('DEPLOY-011 an adapter reporting status "error" is surfaced as a thrown error, never silently returned as undefined', async t => {
  const graduationAdapters = new Map([['devops-platform', () => Promise.resolve({ status: 'error', message: 'payload.name is required' })]]);
  const directory = mkdtempSync(join(tmpdir(), 'pac-graduate-error-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { server } = createDemo({ directory, ownerToken: 'g'.repeat(64), builder: { mode: 'Test compiler · no container isolation', build: async c => compile(c) }, graduationAdapters });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call2 = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'g'.repeat(64) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, data: await r.json() }));
  const created = await call2('/api/apps', staticConfig);
  await call2(`/api/apps/${created.data.id}/build`, {});
  await new Promise(r => setTimeout(r, 50));
  await call2(`/api/apps/${created.data.id}/publish`, {});
  const res = await call2(`/api/apps/${created.data.id}/graduate`, { adapter: 'devops-platform', target: 'cloudfront' });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /payload.name is required/);
  server.close();
});
