import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeployKitClient } from '../lib/client.js';
import { startFakeDeployKit } from './fake-deploykit-server.js';

test('CLIENT-001 rejects construction without apiUrl or token', () => {
  assert.throws(() => createDeployKitClient({ token: 'x' }), /requires apiUrl/);
  assert.throws(() => createDeployKitClient({ apiUrl: 'http://x' }), /requires token/);
});

test('CLIENT-002 deploy posts the spec, follows the SSE stream to completion, and returns the final status', async t => {
  const { server, port, calls } = await startFakeDeployKit();
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token', user: 'wes' });
  const outcome = await client.deploy({ id: 'demo-app', name: 'Demo App', local_path: 'demo-app', port: 3000, path_prefix: '/demo-app', health_endpoint: '/health', env_vars: {}, memory_limit: '512m', cpu_limit: '0.5', sync_capable: false });
  assert.equal(outcome.errored, false);
  assert.equal(outcome.result.status, 'running');
  assert.equal(outcome.result.app_id, 'demo-app');
  const deployCall = calls.find(c => c.path === '/api/v1/deploy');
  assert.equal(deployCall.body.spec.id, 'demo-app');
  assert.equal(deployCall.user, 'wes');
});

test('CLIENT-003 a failing deploy is reported through the SSE error event, not swallowed', async t => {
  const { server, port } = await startFakeDeployKit({ failDeploy: true });
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  const outcome = await client.deploy({ id: 'broken-app', name: 'Broken', local_path: 'broken-app', port: 3000, path_prefix: '/broken-app', health_endpoint: '/health', env_vars: {}, memory_limit: '512m', cpu_limit: '0.5', sync_capable: false });
  assert.equal(outcome.errored, true);
  assert.ok(outcome.logs.some(l => l.level === 'error' && /Docker build failed/.test(l.message)));
});

test('CLIENT-004 status/list/logs/stop/start/undeploy round-trip against the fake server', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  await client.deploy({ id: 'demo-app', name: 'Demo', local_path: 'demo-app', port: 3000, path_prefix: '/demo-app', health_endpoint: '/health', env_vars: {}, memory_limit: '512m', cpu_limit: '0.5', sync_capable: false });
  assert.equal((await client.status('demo-app')).status, 'running');
  assert.ok((await client.list()).some(a => a.app_id === 'demo-app'));
  assert.match((await client.logs('demo-app', 50)).logs, /fake log line/);
  assert.equal((await client.stop('demo-app')).status, 'stopped');
  assert.equal((await client.start('demo-app')).status, 'running');
  await client.undeploy('demo-app');
  await assert.rejects(() => client.status('demo-app'), /404/);
});

test('CLIENT-005 an authentication failure surfaces the HTTP status, not a generic error', async t => {
  const { server, port } = await startFakeDeployKit({});
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'wrong-token' });
  await assert.rejects(() => client.status('demo-app'), /401/);
});

test('CLIENT-006 sync falls back cleanly when the target has no existing container', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  await assert.rejects(() => client.sync('never-deployed'), /404/);
});

test('CLIENT-007 setAccess PUTs the allowlist to /api/v1/access/:app_id', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  const result = await client.setAccess('demo-app', ['alice@plymouthrock.com', 'bob@plymouthrock.com']);
  assert.equal(result.app_id, 'demo-app');
  assert.deepEqual(result.allowed_emails, ['alice@plymouthrock.com', 'bob@plymouthrock.com']);
});

test('CLIENT-008 provisionDb POSTs app_id and enable_pgvector to /api/v1/provision-db', async t => {
  const { server, port, calls } = await startFakeDeployKit();
  t.after(() => server.close());
  const client = createDeployKitClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  const result = await client.provisionDb('demo-app', { enablePgvector: true });
  assert.equal(result.app_id, 'demo-app');
  const call = calls.find(c => c.path === '/api/v1/provision-db');
  assert.equal(call.body.app_id, 'demo-app');
  assert.equal(call.body.enable_pgvector, true);
});
