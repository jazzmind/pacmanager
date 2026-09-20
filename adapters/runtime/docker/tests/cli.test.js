import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeDeployKit } from './fake-deploykit-server.js';
import { startFakeLiteLLMKeyServer } from './fake-litellm-key-server.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function invoke(payload, operation, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', () => { out ? resolve(JSON.parse(out)) : reject(new Error(err)); });
    child.stdin.end(JSON.stringify({ requestId: randomUUID(), artifactId: 'app-1', capability: 'runtime', operation, deadline: Date.now() + 30000, payload }));
  });
}

test('DEPLOYKIT-CLI-001 deploy materializes an inline static-tier source and calls the real HTTP+SSE path end to end', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const workdir = mkdtempSync(join(tmpdir(), 'pac-cli-workdir-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const result = await invoke(
    { id: 'arcade-demo-a1b2c3', displayName: 'Arcade Demo', port: 3000, pathPrefix: '/arcade-demo', source: { 'index.html': '<h1>hi</h1>' } },
    'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token', DEPLOYKIT_WORKDIR: workdir },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.output.app_id, 'arcade-demo-a1b2c3');
  assert.equal(readFileSync(join(workdir, 'arcade-demo-a1b2c3', 'index.html'), 'utf8'), '<h1>hi</h1>');
});

test('DEPLOYKIT-CLI-002 a failed deploy is reported as status:error with a real message, not swallowed', async t => {
  const { server, port } = await startFakeDeployKit({ failDeploy: true });
  t.after(() => server.close());
  const workdir = mkdtempSync(join(tmpdir(), 'pac-cli-workdir-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const result = await invoke(
    { id: 'broken-app', source: { 'index.html': 'x' } }, 'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token', DEPLOYKIT_WORKDIR: workdir },
  );
  assert.equal(result.status, 'error');
  assert.match(result.message, /Docker build failed/);
});

test('DEPLOYKIT-CLI-003 status/logs/undeploy round-trip through the CLI using payload.id', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const workdir = mkdtempSync(join(tmpdir(), 'pac-cli-workdir-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const env = { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token', DEPLOYKIT_WORKDIR: workdir };

  await invoke({ id: 'demo-app', source: { 'index.html': 'x' } }, 'deploy', env);
  const status = await invoke({ id: 'demo-app' }, 'status', env);
  assert.equal(status.status, 'ok');
  assert.equal(status.output.status, 'running');
  const logs = await invoke({ id: 'demo-app', tail: 25 }, 'logs', env);
  assert.match(logs.output.logs, /fake log line/);
  const undeployed = await invoke({ id: 'demo-app' }, 'undeploy', env);
  assert.equal(undeployed.status, 'ok');
});

test('DEPLOYKIT-CLI-004 a request missing payload.id fails closed with a clear message for operations that need it', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const env = { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token' };
  const result = await invoke({}, 'status', env);
  assert.equal(result.status, 'error');
  assert.match(result.message, /requires payload.id/);
});

test('DEPLOYKIT-CLI-005 an unsupported capability is rejected before any network call', async () => {
  const child = spawn('node', [cliPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const done = new Promise(resolve => child.on('close', resolve));
  child.stdin.end(JSON.stringify({ requestId: 'r1', capability: 'graduate', operation: 'deploy', deadline: Date.now() + 1000, payload: {} }));
  await done;
  const result = JSON.parse(out);
  assert.equal(result.status, 'error');
  assert.match(result.message, /Unsupported capability/);
});

test('DEPLOYKIT-CLI-006 a sync-capable app falls back to a full deploy when no container exists yet, then syncs on the next deploy', async t => {
  const { server, port, calls } = await startFakeDeployKit();
  t.after(() => server.close());
  const workdir = mkdtempSync(join(tmpdir(), 'pac-cli-workdir-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const env = { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token', DEPLOYKIT_WORKDIR: workdir };

  const first = await invoke({ id: 'iter-app', syncCapable: true, source: { 'index.html': 'v1' } }, 'deploy', env);
  assert.equal(first.status, 'ok');
  assert.ok(calls.some(c => c.path === '/api/v1/deploy'), 'first deploy of a sync-capable app with no existing container must fall back to a full /deploy');

  const second = await invoke({ id: 'iter-app', syncCapable: true, source: { 'index.html': 'v2' } }, 'deploy', env);
  assert.equal(second.status, 'ok');
  assert.ok(calls.some(c => c.path === '/api/v1/sync/iter-app'), 'a subsequent deploy of an already-running sync-capable app must use the fast /sync path, not rebuild');
});

test('DEPLOYKIT-CLI-007 setAccess dispatches to the client and requires payload.id', async t => {
  const { server, port } = await startFakeDeployKit();
  t.after(() => server.close());
  const env = { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token' };
  const result = await invoke({ id: 'demo-app', allowedEmails: ['alice@plymouthrock.com'] }, 'setAccess', env);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output.allowed_emails, ['alice@plymouthrock.com']);
  const missing = await invoke({ allowedEmails: [] }, 'setAccess', env);
  assert.equal(missing.status, 'error');
  assert.match(missing.message, /requires payload\.id/);
});

test('DEPLOYKIT-CLI-008 a pgvector envRef triggers an explicit provision-db call with enable_pgvector before deploy; a plain postgres envRef does not', async t => {
  const { server, port, calls } = await startFakeDeployKit();
  t.after(() => server.close());
  const env = { DEPLOYKIT_API_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_TOKEN: 'test-token' };

  const withVector = await invoke({ id: 'vector-app', image: 'nginx:latest', envRefs: { DATABASE_URL: 'pgvector' } }, 'deploy', env);
  assert.equal(withVector.status, 'ok');
  const provisionCall = calls.find(c => c.path === '/api/v1/provision-db' && c.body.app_id === 'vector-app');
  assert.ok(provisionCall, 'pgvector envRef must trigger an explicit provision-db call');
  assert.equal(provisionCall.body.enable_pgvector, true);

  const plain = await invoke({ id: 'plain-app', image: 'nginx:latest', envRefs: { DATABASE_URL: 'postgres' } }, 'deploy', env);
  assert.equal(plain.status, 'ok');
  assert.ok(!calls.some(c => c.path === '/api/v1/provision-db' && c.body.app_id === 'plain-app'), 'a plain postgres envRef must not trigger the explicit pgvector call');
});

test('DEPLOYKIT-CLI-009 a litellm envRef mints a scoped LiteLLM key and injects it as LITELLM_API_KEY instead of the shared master key', async t => {
  const { server: dkServer, port: dkPort, calls: dkCalls } = await startFakeDeployKit();
  t.after(() => dkServer.close());
  const { server: llmServer, port: llmPort, calls: llmCalls } = await startFakeLiteLLMKeyServer({ masterKey: 'sk-master-secret' });
  t.after(() => llmServer.close());

  const result = await invoke(
    { id: 'ai-app', image: 'nginx:latest', envRefs: { LITELLM_URL: 'litellm' } },
    'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${dkPort}`, DEPLOYKIT_TOKEN: 'test-token', PAC_LITELLM_URL: `http://127.0.0.1:${llmPort}`, PAC_LITELLM_KEY: 'sk-master-secret' },
  );
  assert.equal(result.status, 'ok');

  const deployCall = dkCalls.find(c => c.path === '/api/v1/deploy');
  assert.ok(deployCall, 'deploy must have been called');
  // The scoped key, not the master key, must be what the app actually receives.
  assert.equal(deployCall.body.spec.env_vars.LITELLM_API_KEY, 'sk-generated-1');
  assert.notEqual(deployCall.body.spec.env_vars.LITELLM_API_KEY, 'sk-master-secret');

  const generateCall = llmCalls.find(c => c.path === '/key/generate');
  assert.ok(generateCall, '/key/generate must have been called');
  assert.equal(generateCall.body.key_alias, 'pac-app-ai-app');
});

test('DEPLOYKIT-CLI-010 redeploying the same app deletes its previous scoped key and mints a fresh one (verified live: LiteLLM never returns a reusable raw value from /key/list, so replacement is the only correct strategy -- see lib/litellm-keys.js)', async t => {
  const { server: dkServer, port: dkPort, calls: dkCalls } = await startFakeDeployKit();
  t.after(() => dkServer.close());
  const { server: llmServer, port: llmPort, calls: llmCalls } = await startFakeLiteLLMKeyServer({
    masterKey: 'sk-master-secret',
    existingKeys: [{ key_alias: 'pac-app-ai-app', key: 'sk-already-issued' }],
  });
  t.after(() => llmServer.close());

  const result = await invoke(
    { id: 'ai-app', image: 'nginx:latest', envRefs: { LITELLM_URL: 'litellm' } },
    'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${dkPort}`, DEPLOYKIT_TOKEN: 'test-token', PAC_LITELLM_URL: `http://127.0.0.1:${llmPort}`, PAC_LITELLM_KEY: 'sk-master-secret' },
  );
  assert.equal(result.status, 'ok');
  assert.ok(llmCalls.some(c => c.path === '/key/delete'), 'the previous key for this alias must be deleted first');
  const generateCall = llmCalls.find(c => c.path === '/key/generate');
  assert.ok(generateCall, 'a fresh key must be minted after the delete');
  const deployCall = dkCalls.find(c => c.path === '/api/v1/deploy');
  assert.notEqual(deployCall.body.spec.env_vars.LITELLM_API_KEY, 'sk-already-issued', 'the app must receive the newly-minted key, not the stale one');
});

test('DEPLOYKIT-CLI-011 an explicit payload.envVars.LITELLM_API_KEY still overrides the scoped key, matching appspec.js\'s existing "explicit wins" rule', async t => {
  const { server: dkServer, port: dkPort, calls: dkCalls } = await startFakeDeployKit();
  t.after(() => dkServer.close());
  const { server: llmServer, port: llmPort } = await startFakeLiteLLMKeyServer({ masterKey: 'sk-master-secret' });
  t.after(() => llmServer.close());

  await invoke(
    { id: 'ai-app', image: 'nginx:latest', envRefs: { LITELLM_URL: 'litellm' }, envVars: { LITELLM_API_KEY: 'sk-hand-issued' } },
    'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${dkPort}`, DEPLOYKIT_TOKEN: 'test-token', PAC_LITELLM_URL: `http://127.0.0.1:${llmPort}`, PAC_LITELLM_KEY: 'sk-master-secret' },
  );
  const deployCall = dkCalls.find(c => c.path === '/api/v1/deploy');
  assert.equal(deployCall.body.spec.env_vars.LITELLM_API_KEY, 'sk-hand-issued');
});

test('DEPLOYKIT-CLI-012 undeploy revokes the app\'s scoped LiteLLM key', async t => {
  const { server: dkServer, port: dkPort } = await startFakeDeployKit();
  t.after(() => dkServer.close());
  const { server: llmServer, port: llmPort, calls: llmCalls, issued } = await startFakeLiteLLMKeyServer({
    masterKey: 'sk-master-secret',
    existingKeys: [{ key_alias: 'pac-app-ai-app', key: 'sk-already-issued' }],
  });
  t.after(() => llmServer.close());

  const result = await invoke(
    { id: 'ai-app' },
    'undeploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${dkPort}`, DEPLOYKIT_TOKEN: 'test-token', PAC_LITELLM_URL: `http://127.0.0.1:${llmPort}`, PAC_LITELLM_KEY: 'sk-master-secret' },
  );
  assert.equal(result.status, 'ok');
  const deleteCall = llmCalls.find(c => c.path === '/key/delete');
  assert.ok(deleteCall, '/key/delete must have been called');
  assert.deepEqual(deleteCall.body.key_aliases, ['pac-app-ai-app']);
  assert.ok(!issued.has('pac-app-ai-app'));
});

test('DEPLOYKIT-CLI-013 a deploy fails closed (not open) when a scoped key can\'t be issued, rather than falling back to the master key', async t => {
  const { server: dkServer, port: dkPort } = await startFakeDeployKit();
  t.after(() => dkServer.close());
  // Deliberately point at a port nothing is listening on, so /key/list and /key/generate both fail.
  const result = await invoke(
    { id: 'ai-app', image: 'nginx:latest', envRefs: { LITELLM_URL: 'litellm' } },
    'deploy',
    { DEPLOYKIT_API_URL: `http://127.0.0.1:${dkPort}`, DEPLOYKIT_TOKEN: 'test-token', PAC_LITELLM_URL: 'http://127.0.0.1:1', PAC_LITELLM_KEY: 'sk-master-secret' },
  );
  assert.equal(result.status, 'error');
  assert.match(result.message, /Failed to issue a scoped LiteLLM key/);
});
