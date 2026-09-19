import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

// Archive/purge over the real HTTP + MCP surface -- test/lifecycle.test.js already covers the
// store logic directly; this proves the routes and tool dispatch actually wire to it.

const config = { title: 'Lifecycle HTTP Test', brief: 'Exercises the archive/purge routes.', template: 'claims', accent: 'teal' };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-lifecycle-http-')), ownerToken = randomBytes(32).toString('hex');
  const runtime = createDemo({ directory, ownerToken, builder: createBuilder('process') });
  await new Promise(r => runtime.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + runtime.server.address().port;
  t.after(() => { runtime.server.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = async (path, { method, body } = {}) => {
    const res = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + ownerToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { runtime, call };
}

test('LIFECYCLE-HTTP-001 DELETE archives; GET /api/apps omits it; ?archived=1 includes it; the app is still directly fetchable', async t => {
  const { call } = await fixture(t);
  const created = await call('/api/apps', { body: config });
  const id = created.data.id;

  assert.equal((await call('/api/apps')).data.length, 1);
  const deleted = await call('/api/apps/' + id, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.data.archivedAt);

  assert.equal((await call('/api/apps')).data.length, 0);
  assert.equal((await call('/api/apps?archived=1')).data.length, 1);
  assert.equal((await call('/api/apps/' + id)).status, 200); // still directly reachable
});

test('LIFECYCLE-HTTP-002 unarchive restores it to the list', async t => {
  const { call } = await fixture(t);
  const { data: { id } } = await call('/api/apps', { body: config });
  await call('/api/apps/' + id, { method: 'DELETE' });
  const restored = await call('/api/apps/' + id + '/unarchive', { body: {} });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.archivedAt, null);
  assert.equal((await call('/api/apps')).data.length, 1);
});

test('LIFECYCLE-HTTP-003 purge refuses on a non-archived app, then succeeds once archived', async t => {
  const { call } = await fixture(t);
  const { data: { id } } = await call('/api/apps', { body: config });
  const refused = await call('/api/apps/' + id + '/purge', { body: {} });
  assert.equal(refused.status, 409);

  await call('/api/apps/' + id, { method: 'DELETE' });
  const purged = await call('/api/apps/' + id + '/purge', { body: {} });
  assert.equal(purged.status, 200);
  assert.deepEqual(purged.data, { purged: true, id });
  assert.equal((await call('/api/apps/' + id)).status, 404);
});

test('LIFECYCLE-HTTP-004 archive_application / unarchive_application / purge_application over MCP', async t => {
  const { call } = await fixture(t);
  const mcpCall = async (name, args) => {
    const res = await call('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    return JSON.parse(res.data.result.content[0].text);
  };
  const created = await mcpCall('create_application', config);
  const archived = await mcpCall('archive_application', { id: created.id });
  assert.ok(archived.archivedAt);
  const list = JSON.parse((await call('/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_applications', arguments: {} } } })).data.result.content[0].text);
  assert.equal(list.length, 0);
  const restored = await mcpCall('unarchive_application', { id: created.id });
  assert.equal(restored.archivedAt, null);
  await mcpCall('archive_application', { id: created.id });
  const purged = await mcpCall('purge_application', { id: created.id });
  assert.deepEqual(purged, { purged: true, id: created.id });
});
