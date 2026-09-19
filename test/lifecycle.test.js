import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../demo/definition.js';
import { Store } from '../demo/store.js';

// Archive-then-purge (see the platform gap analysis / roadmap): delete was previously
// impossible -- state.apps was only ever pushed to, nothing removed a record, and invites/
// collaborator sessions carrying an appId were never pruned. archive() is soft and
// reversible; purge() is the real destructive step and only runs on an already-archived app.

const owner = { kind: 'owner', label: 'Workspace owner' };
const staticConfig = { title: 'Lifecycle Test', brief: 'Exercises archive/purge.', template: 'knowledge', accent: 'blue', tier: 'static', source: { 'index.html': '<div>hi</div>' } };

function storeFixture(t, runtime) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-lifecycle-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new Store(directory, { mode: 'test', build: async c => compile(c) }, runtime);
}

test('LIFECYCLE-001 archive hides an app from list() but leaves it directly reachable', t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  assert.equal(store.list(owner).length, 1);
  store.archive(owner, app.id);
  assert.equal(store.list(owner).length, 0);
  assert.equal(store.list(owner, { includeArchived: true }).length, 1);
  assert.ok(app.archivedAt);
  assert.equal(app.archivedBy, owner.label);
  // Still directly reachable -- archive is not a delete.
  const viewed = store.view(owner, app.id);
  assert.equal(viewed.config.title, 'Lifecycle Test');
});

test('LIFECYCLE-002 archiving twice fails clearly; unarchive restores it to list()', t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  store.archive(owner, app.id);
  assert.throws(() => store.archive(owner, app.id), /Already archived/);
  store.unarchive(owner, app.id);
  assert.equal(store.list(owner).length, 1);
  assert.equal(app.archivedAt, null);
  assert.throws(() => store.unarchive(owner, app.id), /Not archived/);
});

test('LIFECYCLE-003 purge refuses on a non-archived app', async t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  await assert.rejects(() => store.purge(owner, app.id), /Archive this application before purging/);
});

test('LIFECYCLE-004 purge removes the app record, its invites and its collaborator sessions', async t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  const inviteToken = store.invite(owner, app.id, 'Colleague');
  const collaboratorSession = store.accept(inviteToken);
  assert.equal(store.state.invites.some(i => i.appId === app.id), true);
  assert.equal(store.state.sessions.some(s => s.appId === app.id), true);

  store.archive(owner, app.id);
  const result = await store.purge(owner, app.id);
  assert.deepEqual(result, { purged: true, id: app.id });

  assert.equal(store.state.apps.some(a => a.id === app.id), false);
  assert.equal(store.state.invites.some(i => i.appId === app.id), false, 'orphaned invite must be pruned');
  assert.equal(store.state.sessions.some(s => s.appId === app.id), false, 'orphaned collaborator session must be pruned');
  assert.throws(() => store.access(owner, app.id), /Application not found/);
});

test('LIFECYCLE-005 purge removes the generation workdir on disk, never config.sourcePath', async t => {
  const store = storeFixture(t);
  const app = store.create(owner, { title: 'App Tier', brief: 'A referenced app-tier source.', kind: 'application', accent: 'blue', tier: 'intent' });
  // Simulate a completed "application"-kind generation: a real workdir under this.dataDir.
  const workdir = join(store.dataDir, 'generated', app.id);
  mkdirSync(workdir, { recursive: true });
  app.config = { title: app.config.title, brief: app.config.brief, kind: 'application', accent: app.config.accent, tier: 'app', sourcePath: workdir, dockerfile: 'Dockerfile' };
  // A hand-authored sourcePath elsewhere on disk must survive purge untouched.
  const elsewhere = mkdtempSync(join(tmpdir(), 'pac-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  store.archive(owner, app.id);
  await store.purge(owner, app.id);
  assert.equal(existsSync(workdir), false, 'the generation workdir this store created must be removed');
  assert.equal(existsSync(elsewhere), true, 'a directory outside the generation workdir must never be touched');
});

test('LIFECYCLE-006 purge on a deployed app refuses without force, and attempts undeploy when forced', async t => {
  const calls = [];
  const runtime = { undeploy: async args => { calls.push(args); return { status: 'ok', output: {} }; } };
  const store = storeFixture(t, runtime);
  const app = store.create(owner, staticConfig);
  app.deployId = 'lifecycle-test-app-abc123'; // simulate a prior deploy without running the full build/publish/deploy chain
  store.archive(owner, app.id);

  await assert.rejects(() => store.purge(owner, app.id), /This application has been deployed/);
  assert.equal(calls.length, 0);

  const result = await store.purge(owner, app.id, { force: true });
  assert.deepEqual(result, { purged: true, id: app.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.id, 'lifecycle-test-app-abc123');
});

test('LIFECYCLE-007 purge with force still completes even if the runtime undeploy call fails', async t => {
  const runtime = { undeploy: async () => { throw new Error('adapter unreachable'); } };
  const store = storeFixture(t, runtime);
  const app = store.create(owner, staticConfig);
  app.deployId = 'lifecycle-test-app-def456';
  store.archive(owner, app.id);
  const result = await store.purge(owner, app.id, { force: true });
  assert.deepEqual(result, { purged: true, id: app.id });
});

test('LIFECYCLE-008 list() reports generation status, release number, createdAt and lastDeployment -- fields it previously omitted', t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  store.startBuild(owner, app.id);
  return store.lastBuild.then(() => {
    store.publish(owner, app.id);
    const [row] = store.list(owner);
    assert.equal(row.createdAt, app.createdAt);
    assert.deepEqual(row.release, { number: 1 });
    assert.equal(row.generation, null); // classic template-tier app never generates
    assert.equal(row.archivedAt, null);
    assert.equal(row.lastDeployment, null); // never deployed
  });
});

test('LIFECYCLE-009 non-owner cannot archive or purge someone else\'s app', async t => {
  const store = storeFixture(t);
  const app = store.create(owner, staticConfig);
  const other = { kind: 'user', label: 'bob', email: 'bob@plymouthrock.com' };
  assert.throws(() => store.archive(other, app.id), /Application not found/);
  await assert.rejects(() => store.purge(other, app.id), /Application not found/);
});
