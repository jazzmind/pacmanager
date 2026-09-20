import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLiteLLM } from './fake-litellm-server.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

function run(request, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, result: JSON.parse(out), err }); } catch (e) { reject(new Error(`bad stdout (${err}): ${out}`)); } });
    child.stdin.end(JSON.stringify(request));
  });
}

const envelope = (operation, payload) => ({ requestId: 'r1', artifactId: 'app-1', capability: 'authoring', operation, payload, deadline: Date.now() + 30000 });

test('CLI-001 rejects a request for an unsupported capability without ever calling the provider', async () => {
  const { result } = await run({ ...envelope('generate', {}), capability: 'runtime' }, {});
  assert.equal(result.status, 'error');
  assert.match(result.message, /Unsupported capability/);
});

test('CLI-002 probe round-trips through a real spawned process against a fake litellm server', async t => {
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply: 'ok' });
  t.after(() => server.close());
  const { result } = await run(envelope('probe', {}), { DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' });
  assert.equal(result.status, 'ok');
  assert.equal(result.output.available, true);
});

test('CLI-003 generate round-trips an interactive-kind reply end to end, including a stray ``` fence models tend to add', async t => {
  const reply = '```\n@@PAC_KIND: interactive@@\n@@PAC_FILE: index.html@@\n<h1>Tapper</h1>\n@@PAC_END@@\n```';
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply });
  t.after(() => server.close());
  const { result } = await run(
    envelope('generate', { kind: 'interactive', title: 'Tapper Clone', brief: 'An arcade game.', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: { maxFiles: 25, maxBytes: 512000, extensions: ['.html'], requiredFiles: ['index.html'], forbidden: [] } }),
    { DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.output.kind, 'interactive');
  assert.deepEqual(result.output.source, { 'index.html': '<h1>Tapper</h1>' });
});

test('CLI-004 generate for kind "application" actually writes files under the given workdir and returns sourcePath', async t => {
  const reply = '@@PAC_KIND: application@@\n@@PAC_FILE: Dockerfile@@\nFROM node:22-alpine\n@@PAC_FILE: server.js@@\nconsole.log(1)\n@@PAC_END@@';
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply });
  const workdir = mkdtempSync(join(tmpdir(), 'pac-cli-workdir-'));
  t.after(() => { server.close(); rmSync(workdir, { recursive: true, force: true }); });
  const { result } = await run(
    envelope('generate', { kind: 'application', title: 'Mini API', brief: 'A tiny API.', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {}, workdir }),
    { DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.output.sourcePath, workdir);
  assert.equal(readFileSync(join(workdir, 'Dockerfile'), 'utf8'), 'FROM node:22-alpine');
});

test('CLI-005 a malformed model reply surfaces as status:"error" with a specific parse complaint, not a crash -- and is marked retriable, since pacmanager\'s repair loop (not this adapter) owns retrying', async t => {
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply: 'sorry, I refuse to help with that' });
  t.after(() => server.close());
  const { result } = await run(
    envelope('generate', { kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {} }),
    { DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' },
  );
  assert.equal(result.status, 'error');
  assert.match(result.message, /missing @@PAC_KIND/);
  assert.equal(result.retriable, true);
});

test('CLI-007 a genuine provider failure (broken credential) is NOT marked retriable', async t => {
  const { result } = await run(
    envelope('generate', { kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {} }),
    {}, // no DEPLOYKIT_LITELLM_KEY at all
  );
  assert.equal(result.status, 'error');
  assert.match(result.message, /litellm_not_configured/);
  assert.equal(result.retriable, undefined);
});

test('CLI-006 no credentials configured at all fails with the specific litellm_not_configured message', async () => {
  const { result } = await run(envelope('probe', {}), {});
  assert.equal(result.status, 'error');
  assert.match(result.message, /litellm_not_configured/);
});
