import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../demo/definition.js';
import { Store } from '../demo/store.js';

// Real AI generation, store-level (see docs/implementation-status.md's generation design).
// Uses an in-process fake authoring adapter (not a spawned process — that contract is already
// covered by test/authoring-adapter.test.js) so each test can script exact response sequences:
// reject-then-accept, exhaust-all-attempts, containment violations, etc.

const owner = { kind: 'owner', label: 'Connected author' };

function fakeAuthoring(responses) {
  const calls = [];
  return {
    mode: 'fake-authoring-adapter',
    calls,
    async generate(args) {
      calls.push(args);
      const r = responses[calls.length - 1] ?? responses[responses.length - 1];
      return typeof r === 'function' ? r(args) : r;
    },
    async probe() { return { status: 'ok', output: { model: 'fake-model' } }; },
  };
}

function storeFixture(t, authoring) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-gen-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const builder = { mode: 'test', build: async c => compile(c) };
  return new Store(directory, builder, null, new Map(), authoring);
}

const intentApp = { title: 'Tapper Clone', brief: 'A clone of the arcade game Tapper, insurance themed.', kind: 'interactive', accent: 'teal', tier: 'intent' };

test('GEN-101 a successful first-attempt generation writes source, bumps revision exactly once, and marks generation ready', async t => {
  const authoring = fakeAuthoring([{ status: 'ok', output: { kind: 'interactive', model: 'claude-sonnet-5', source: { 'index.html': '<h1>Tapper</h1>', 'app.js': 'const x = 1;' } } }]);
  const store = storeFixture(t, authoring);
  const app = store.create(owner, intentApp);
  assert.equal(app.revision, 1);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.config.tier, 'static');
  assert.deepEqual(app.config.source, { 'index.html': '<h1>Tapper</h1>', 'app.js': 'const x = 1;' });
  assert.equal(app.revision, 2); // bumped exactly once
  assert.equal(app.generation.status, 'ready');
  assert.equal(app.generation.model, 'claude-sonnet-5');
});

test('GEN-102 a rejected first attempt (forbidden fetch) is repaired on the second, with the exact issue fed back as previousAttempt', async t => {
  const authoring = fakeAuthoring([
    { status: 'ok', output: { kind: 'interactive', model: 'claude-sonnet-5', source: { 'index.html': '<h1>hi</h1>', 'app.js': 'fetch("https://evil.example")' } } },
    { status: 'ok', output: { kind: 'interactive', model: 'claude-sonnet-5', source: { 'index.html': '<h1>hi</h1>', 'app.js': 'const ok = 1;' } } },
  ]);
  const store = storeFixture(t, authoring);
  const app = store.create(owner, intentApp);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'ready');
  assert.equal(app.generation.attempts.length, 1);
  assert.ok(app.generation.attempts[0].issues.some(i => i.includes('fetch')));
  // The second call's payload must carry the first attempt's rejected source + issues back.
  assert.ok(authoring.calls[1].payload.previousAttempt);
  assert.ok(authoring.calls[1].payload.previousAttempt.issues.some(i => i.includes('fetch')));
  assert.equal(app.config.source['app.js'], 'const ok = 1;');
});

test('GEN-103 exhausting all attempts fails cleanly — config and revision are untouched, nothing partial is saved', async t => {
  const badOutput = { status: 'ok', output: { kind: 'interactive', model: 'claude-sonnet-5', source: { 'index.html': '<h1>hi</h1>', 'app.js': 'fetch("https://evil.example")' } } };
  const store = storeFixture(t, fakeAuthoring([badOutput, badOutput, badOutput]));
  const app = store.create(owner, intentApp);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'failed');
  assert.equal(app.generation.attempts.length, 3);
  assert.equal(app.config.tier, 'intent'); // still ungenerated
  assert.equal(app.revision, 1); // never bumped
  assert.match(app.generation.logs.at(-1).text, /failed after 3 attempts/);
});

test('GEN-104 requireAuthoring fails closed with a specific, actionable message when unconfigured', async t => {
  const store = storeFixture(t, null);
  const app = store.create(owner, intentApp);
  await assert.rejects(() => store.startGeneration(owner, app.id), /No authoring adapter configured. Set PAC_AUTHORING_ADAPTER/);
});

test('GEN-105 a generation cannot start while a build is running, and a build cannot start while generation is running or the tier is still "intent"', async t => {
  const store = storeFixture(t, fakeAuthoring([{ status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>hi</h1>' } } }]));
  const intentAppRecord = store.create(owner, intentApp);
  // tier:'intent' blocks build outright.
  assert.throws(() => store.startBuild(owner, intentAppRecord.id), /Generate this artifact before building it/);

  // A static-tier app mid-build blocks generation.
  const staticApp = store.create(owner, { title: 'Static App', brief: 'test test test test', template: 'claims', accent: 'teal', tier: 'static', source: { 'index.html': '<h1>hi</h1>' } });
  store.startBuild(owner, staticApp.id); // fires async, leaves build.status:'building' synchronously
  await assert.rejects(() => store.startGeneration(owner, staticApp.id), /Wait for the current build to finish/);
});

test('GEN-106 regenerating after a publish makes the prior release stale — the existing publish guard blocks publishing without a fresh build', async t => {
  const store = storeFixture(t, fakeAuthoring([{ status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>v1</h1>' } } }]));
  const app = store.create(owner, intentApp);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration; // revision -> 2, tier -> static
  store.startBuild(owner, app.id);
  await store.lastBuild;
  store.publish(owner, app.id); // release recorded at revision 2

  // Regenerate: same fake adapter (single scripted response) still returns something, revision bumps to 3.
  store.authoring = fakeAuthoring([{ status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>v2</h1>' } } }]);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.revision, 3);
  assert.throws(() => store.publish(owner, app.id), /Build the current draft before publishing/);
});

test('GEN-111 an adapter-reported error marked retriable (e.g. the model\'s own reply was malformed JSON) is repaired on retry, not hard-failed immediately', async t => {
  const authoring = fakeAuthoring([
    { status: 'error', message: 'Model reply was not valid JSON: Bad control character in string literal', retriable: true },
    { status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>hi</h1>' } } },
  ]);
  const store = storeFixture(t, authoring);
  const app = store.create(owner, intentApp);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'ready');
  assert.equal(app.generation.attempts.length, 1);
  assert.ok(app.generation.attempts[0].issues[0].includes('Bad control character'));
  assert.equal(authoring.calls.length, 2); // it really did retry
});

test('GEN-112 an adapter-reported error NOT marked retriable (e.g. a broken credential) hard-fails immediately, without wasting the repair budget on a dead gateway', async t => {
  const authoring = fakeAuthoring([{ status: 'error', message: 'litellm 401: Missing Anthropic API Key' }]);
  const store = storeFixture(t, authoring);
  const app = store.create(owner, intentApp);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'failed');
  assert.equal(authoring.calls.length, 1); // never retried
  assert.match(app.generation.logs.at(-1).text, /Missing Anthropic API Key/);
});

test('GEN-107 kind "auto" requires a rationale — rejected without one, accepted and audited with one', async t => {
  const store = storeFixture(t, fakeAuthoring([
    { status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>no rationale</h1>' } } }, // missing rationale -> rejected
    { status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>chosen</h1>' }, rationale: 'A simple interactive page best fits this brief.' } },
  ]));
  const app = store.create(owner, { title: 'Auto App', brief: 'test test test test', kind: 'auto', accent: 'teal', tier: 'intent' });
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'ready');
  assert.equal(app.generation.attempts.length, 1);
  assert.ok(app.generation.attempts[0].issues[0].includes('rationale'));
  assert.equal(app.generation.rationale, 'A simple interactive page best fits this brief.');
  assert.ok(app.audit.some(a => a.event.includes('simple interactive page best fits')));
});

test('GEN-108 an "application" artifact\'s sourcePath must be contained in the workdir the host provided — escaping it is a hard failure, never retried', async t => {
  const outside = mkdtempSync(join(tmpdir(), 'pac-gen-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'Dockerfile'), 'FROM scratch');
  const authoring = fakeAuthoring([{ status: 'ok', output: { kind: 'application', model: 'm', sourcePath: outside } }]);
  const store = storeFixture(t, authoring);
  const app = store.create(owner, { title: 'Escaping App', brief: 'test test test test', kind: 'application', accent: 'teal', tier: 'intent' });
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'failed');
  assert.equal(authoring.calls.length, 1); // never retried, regardless of whether the violation is logged as an "attempt"
  assert.match(app.generation.logs.at(-1).text, /escapes the workdir|not retried/);
});

test('GEN-109 an "application" artifact whose sourcePath is genuinely inside the provided workdir is accepted', async t => {
  const store = storeFixture(t, null);
  const app = store.create(owner, { title: 'Real App', brief: 'test test test test', kind: 'application', accent: 'teal', tier: 'intent' });
  const workdir = join(store.dataDir, 'generated', app.id);
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'Dockerfile'), 'FROM node:22-alpine');
  store.authoring = fakeAuthoring([{ status: 'ok', output: { kind: 'application', model: 'm', sourcePath: workdir } }]);
  await store.startGeneration(owner, app.id);
  await store.lastGeneration;
  assert.equal(app.generation.status, 'ready');
  assert.equal(app.config.tier, 'app');
  // Compare via realpathSync on both sides — the stored value is realpath'd (correctly: that's
  // what resolves e.g. macOS's /tmp -> /private/tmp symlink), so a literal string comparison
  // against the pre-resolution workdir path is the wrong assertion, not a code bug.
  assert.equal(realpathSync(app.config.sourcePath), realpathSync(workdir));
});

test('GEN-110 a server restart mid-generation marks it failed instead of leaving it stuck "generating" forever', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pac-gen-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const builder = { mode: 'test', build: async c => compile(c) };
  const store1 = new Store(directory, builder, null, new Map(), fakeAuthoring([]));
  const app = store1.create(owner, intentApp);
  app.generation = { id: 'x', status: 'generating', requestedAtRevision: 1, attempts: [], logs: [] };
  store1.save();
  const store2 = new Store(directory, builder, null, new Map(), null); // simulates a fresh process restart
  const restored = store2.state.apps.find(a => a.id === app.id);
  assert.equal(restored.generation.status, 'failed');
  assert.match(restored.generation.logs.at(-1).text, /restarted during generation/);
});
