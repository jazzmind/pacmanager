import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function run(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => out += b);
    child.stderr.on('data', b => err += b);
    child.on('error', reject);
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON on stdout: ' + out + err)); } });
    child.stdin.end(JSON.stringify(request));
  });
}

// A real Temporal server is proven separately (this adapter was hand-verified live against a
// running local Temporal instance -- see the pacmanager admin console's Temporal test panel).
// These tests cover the envelope contract itself: capability/operation validation and honest
// failure when nothing is actually listening, without standing up a fake gRPC server.

test('TEMPORAL-001 rejects a request for a capability other than orchestration', async () => {
  const result = await run({ capability: 'runtime', operation: 'health', payload: {} });
  assert.equal(result.status, 'error');
  assert.match(result.message, /Unsupported capability/);
});

test('TEMPORAL-002 rejects an unsupported operation', async () => {
  const result = await run({ capability: 'orchestration', operation: 'startWorkflow', payload: {} }, { PAC_TEMPORAL_ADDRESS: '127.0.0.1:1' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /Unsupported orchestration operation/);
});

test('TEMPORAL-003 health fails honestly (not silently) when nothing is listening at the configured address', async () => {
  const result = await run({ capability: 'orchestration', operation: 'health', payload: {} }, { PAC_TEMPORAL_ADDRESS: '127.0.0.1:1' });
  assert.equal(result.status, 'error');
  assert.ok(result.message.length > 0);
});

test('TEMPORAL-004 malformed JSON on stdin fails closed with a JSON error result, not a crash', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', b => out += b);
    child.on('error', reject);
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON on stdout: ' + out)); } });
    child.stdin.end('not json');
  });
  assert.equal(result.status, 'error');
});
