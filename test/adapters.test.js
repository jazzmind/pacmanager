import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { envelope, validateResult, RUNTIME_CAPABILITIES, validateAuthoringOutput } from '../src/adapters.js';
import { createRuntimeAdapter } from '../demo/runtime-adapter.js';
import { createGraduationAdapters } from '../demo/graduation-adapter.js';

const fixture = fileURLToPath(new URL('../demo/fixtures/echo-adapter.js', import.meta.url));
const command = line => `node ${line}`.trim();
const adapter = (extraEnv = {}) => createRuntimeAdapter({ PAC_RUNTIME_ADAPTER: command(fixture), ...extraEnv });

test('ADAPT-001 envelope validates required fields and rejects malformed payloads', () => {
  assert.throws(() => envelope({ capability: 'runtime', operation: 'deploy', deadline: Date.now() + 1000 }), /requestId/);
  assert.throws(() => envelope({ requestId: 'r1', operation: 'deploy', deadline: Date.now() + 1000 }), /capability/);
  assert.throws(() => envelope({ requestId: 'r1', capability: 'runtime', deadline: Date.now() + 1000 }), /operation/);
  assert.throws(() => envelope({ requestId: 'r1', capability: 'runtime', operation: 'deploy', deadline: Date.now() + 1000, payload: 'nope' }), /payload must be an object/);
  assert.throws(() => envelope({ requestId: 'r1', capability: 'runtime', operation: 'deploy', deadline: 0 }), /deadline/);
  const e = envelope({ requestId: 'r1', capability: 'runtime', operation: 'deploy', deadline: Date.now() + 1000 });
  assert.equal(e.artifactId, null); assert.deepEqual(e.payload, {});
});

test('ADAPT-002 validateResult enforces the ok/error result shape', () => {
  assert.throws(() => validateResult(null), /must be an object/);
  assert.throws(() => validateResult({ status: 'weird' }), /status must be/);
  assert.throws(() => validateResult({ status: 'error' }), /error result requires a message/);
  assert.throws(() => validateResult({ status: 'ok', output: 'nope' }), /output must be an object/);
  assert.deepEqual(validateResult({ status: 'ok', output: { a: 1 } }), { status: 'ok', output: { a: 1 } });
});

test('ADAPT-003 runtime adapter is null when unconfigured (callers must fail closed)', () => {
  assert.equal(createRuntimeAdapter({}), null);
});

test('ADAPT-004 runtime adapter round-trips a real operation through a spawned process', async () => {
  const result = await adapter().deploy({ artifactId: 'app-1', payload: { tier: 'static' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.output.echoedOperation, 'deploy');
  assert.equal(result.output.receivedCapability, 'runtime');
  assert.deepEqual(result.output.echoedPayload, { tier: 'static' });
});

test('ADAPT-005 runtime adapter exposes exactly the 10 canonical capabilities, nothing else callable', () => {
  const a = adapter();
  assert.equal(RUNTIME_CAPABILITIES.length, 10);
  for (const op of RUNTIME_CAPABILITIES) assert.equal(typeof a[op], 'function');
  assert.equal(typeof a.destroy_everything, 'undefined');
});

test('ADAPT-006 runtime adapter surfaces a crashing process as a rejected promise, not a hang', async () => {
  await assert.rejects(() => adapter().status({ artifactId: 'x', payload: { testMode: 'crash' } }), /boom|exited with code/);
});

test('ADAPT-007 runtime adapter rejects garbage (non-JSON) adapter output', async () => {
  await assert.rejects(() => adapter().status({ artifactId: 'x', payload: { testMode: 'garbage' } }), /Invalid adapter response/);
});

test('ADAPT-008 runtime adapter rejects a well-formed-JSON but wrong-shaped reply', async () => {
  await assert.rejects(() => adapter().status({ artifactId: 'x', payload: { testMode: 'bad-shape' } }), /status must be/);
});

test('ADAPT-009 runtime adapter enforces its own deadline against a hanging process', async () => {
  await assert.rejects(() => adapter({ PAC_RUNTIME_ADAPTER_TIMEOUT_MS: '200' }).status({ artifactId: 'x', payload: { testMode: 'hang' } }), /timed out/);
});

test('ADAPT-010 graduation adapters parse the name=command list and are empty when unconfigured', async () => {
  assert.equal(createGraduationAdapters({}).size, 0);
  const adapters = createGraduationAdapters({ PAC_GRADUATION_ADAPTERS: `devops-platform=${command(fixture)}` });
  assert.deepEqual([...adapters.keys()], ['devops-platform']);
  const result = await adapters.get('devops-platform')({ 'index.html': '<html></html>' }, { artifactId: 'app-1' });
  assert.equal(result.status, 'ok');
  assert.equal(result.output.receivedCapability, 'graduate');
  assert.deepEqual(result.output.echoedPayload, { files: { 'index.html': '<html></html>' } });
});

test('ADAPT-011 malformed PAC_GRADUATION_ADAPTERS entries fail closed at construction time', () => {
  assert.throws(() => createGraduationAdapters({ PAC_GRADUATION_ADAPTERS: 'no-equals-sign' }), /Invalid PAC_GRADUATION_ADAPTERS/);
});

test('ADAPT-012 validateAuthoringOutput requires a known kind, a model name, and exactly one of source/sourcePath', () => {
  assert.throws(() => validateAuthoringOutput(null), /must be an object/);
  assert.throws(() => validateAuthoringOutput({ kind: 'nonsense', model: 'x', source: {} }), /kind must be one of/);
  assert.throws(() => validateAuthoringOutput({ kind: 'interactive', source: {} }), /model is required/);
  assert.throws(() => validateAuthoringOutput({ kind: 'interactive', model: 'x' }), /exactly one of source or sourcePath/);
  assert.throws(() => validateAuthoringOutput({ kind: 'interactive', model: 'x', source: {}, sourcePath: '/tmp/x' }), /exactly one of source or sourcePath/);
  assert.doesNotThrow(() => validateAuthoringOutput({ kind: 'interactive', model: 'claude-sonnet-5', source: { 'index.html': '<h1>hi</h1>' } }));
  assert.doesNotThrow(() => validateAuthoringOutput({ kind: 'application', model: 'claude-sonnet-5', sourcePath: '/data/generated/app-1' }));
});

test('ADAPT-013 validateAuthoringOutput bounds an oversized rationale', () => {
  assert.throws(() => validateAuthoringOutput({ kind: 'interactive', model: 'x', source: {}, rationale: 'x'.repeat(501) }), /500 characters/);
  assert.doesNotThrow(() => validateAuthoringOutput({ kind: 'interactive', model: 'x', source: {}, rationale: 'short and fine' }));
});
