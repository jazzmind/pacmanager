import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAuthoringAdapter } from '../demo/authoring-adapter.js';
import { validateAuthoringOutput } from '../src/adapters.js';

const fixture = fileURLToPath(new URL('../demo/fixtures/echo-authoring-adapter.js', import.meta.url));
const command = line => `node ${line}`.trim();
const adapter = (extraEnv = {}) => createAuthoringAdapter({ PAC_AUTHORING_ADAPTER: command(fixture), ...extraEnv });

test('AUTHOR-001 authoring adapter is null when unconfigured (callers must fail closed)', () => {
  assert.equal(createAuthoringAdapter({}), null);
});

test('AUTHOR-002 generate round-trips a real operation through a spawned process, and the reply passes validateAuthoringOutput', async () => {
  const result = await adapter().generate({ artifactId: 'app-1', payload: { kind: 'interactive', title: 't', brief: 'b' } });
  assert.equal(result.status, 'ok');
  const output = validateAuthoringOutput(result.output);
  assert.equal(output.kind, 'interactive');
  assert.deepEqual(output.source, { 'index.html': '<h1>Generated</h1>' });
});

test('AUTHOR-003 probe round-trips independently of generate, with its own (shorter) timeout budget', async () => {
  const result = await adapter().probe();
  assert.equal(result.status, 'ok');
  assert.equal(result.output.available, true);
});

test('AUTHOR-004 an adapter-reported error (e.g. gateway unreachable) surfaces as status:"error", not swallowed', async () => {
  const result = await adapter().generate({ artifactId: 'app-1', payload: { testMode: 'gateway_unreachable' } });
  assert.equal(result.status, 'error');
  assert.match(result.message, /gateway_unreachable/);
});

test('AUTHOR-005 a well-formed but invalid-shaped output is caught by validateAuthoringOutput, not silently accepted', async () => {
  const result = await adapter().generate({ artifactId: 'app-1', payload: { testMode: 'bad-output' } });
  assert.equal(result.status, 'ok'); // the transport succeeded...
  assert.throws(() => validateAuthoringOutput(result.output), /kind must be one of/); // ...but the content is invalid
});
