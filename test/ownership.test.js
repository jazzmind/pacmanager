import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../demo/definition.js';
import { Store } from '../demo/store.js';

// Ownership + sharing model (see docs/implementation-status.md Part 3): app records gain
// ownerEmail/sharedWith so an authenticated tenant user (principal.kind==='user', via
// proxy-auth) sees their own apps + apps shared with them, while the admin ('owner' kind)
// still sees everything -- unchanged from before this pass.
//
// A "user" principal can't authenticate over the owner-token bearer path the HTTP-level
// tests elsewhere in this suite use (that path only ever produces kind:'owner' or a
// collaborator session) -- so these tests exercise the store directly, the same way
// existing MCP-bypass fixtures do elsewhere (see test/assurance.test.js's direct
// store.access() calls).

const staticConfig = { title: 'Ownership Test', brief: 'Exercises the ownership/sharing model.', template: 'knowledge', accent: 'blue', tier: 'static', source: { 'index.html': '<div>hi</div>' } };

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-owner-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new Store(directory, { mode: 'test', build: async c => compile(c) });
}

test('OWNERSHIP-001 a user principal creating an app becomes its owner', (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  assert.equal(app.ownerEmail, 'alice@plymouthrock.com');
  assert.deepEqual(app.sharedWith, []);
});

test('OWNERSHIP-002 a collaborator principal cannot create an app', (t) => {
  const store = storeFixture(t);
  const collaborator = { kind: 'collaborator', appId: 'x', label: 'Guest' };
  assert.throws(() => store.create(collaborator, staticConfig), /Sign in/);
});

test('OWNERSHIP-003 list shows a user only their own apps, not another user\'s', (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const bob = { kind: 'user', label: 'bob', email: 'bob@plymouthrock.com' };
  const aliceApp = store.create(alice, staticConfig);
  store.create(bob, { ...staticConfig, title: 'Bob App' });
  const aliceList = store.list(alice);
  assert.equal(aliceList.length, 1);
  assert.equal(aliceList[0].id, aliceApp.id);
});

test('OWNERSHIP-004 the admin (owner kind) sees every app regardless of who created it', (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const admin = { kind: 'owner', label: 'Connected author' };
  store.create(alice, staticConfig);
  store.create(admin, { ...staticConfig, title: 'Admin App' });
  assert.equal(store.list(admin).length, 2);
});

test('OWNERSHIP-005 a user with no relationship to an app gets 404, not 403 (non-enumeration)', (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const carol = { kind: 'user', label: 'carol', email: 'carol@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  assert.throws(() => store.access(carol, app.id), (err) => err.status === 404);
});

test('OWNERSHIP-006 sharing grants access; unsharing revokes it', async (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const bob = { kind: 'user', label: 'bob', email: 'bob@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  assert.throws(() => store.access(bob, app.id));
  await store.shareWithEmail(alice, app.id, 'Bob@PlymouthRock.com'); // mixed case, must normalize
  assert.doesNotThrow(() => store.access(bob, app.id));
  assert.equal(store.list(bob).length, 1);
  await store.unshareEmail(alice, app.id, 'bob@plymouthrock.com');
  assert.throws(() => store.access(bob, app.id));
});

test('OWNERSHIP-007 a non-owner user cannot share someone else\'s app', async (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const bob = { kind: 'user', label: 'bob', email: 'bob@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  // 404 (not 403) -- matches the deliberate non-enumeration behavior access() already has
  // for any non-owner, non-shared principal (see OWNERSHIP-005 and demo.test.js:34).
  await assert.rejects(() => store.shareWithEmail(bob, app.id, 'carol@plymouthrock.com'), /not found/i);
});

test('OWNERSHIP-008 an app-owning user (not the admin) can still perform owner-only actions on their own app', (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  assert.doesNotThrow(() => store.access(alice, app.id, true)); // requireOwner=true
});

test('OWNERSHIP-009 sharing rejects a malformed email', async (t) => {
  const store = storeFixture(t);
  const alice = { kind: 'user', label: 'alice', email: 'alice@plymouthrock.com' };
  const app = store.create(alice, staticConfig);
  await assert.rejects(() => store.shareWithEmail(alice, app.id, 'not-an-email'), /valid email/);
});
