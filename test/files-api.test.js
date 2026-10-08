import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile, sha } from '../demo/definition.js';

const TOKEN = 'h'.repeat(64);
const req = (base, method, path, body, token = TOKEN) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { server, store } = createDemo({ directory, ownerToken: TOKEN, builder: { mode: 'Test', build: async c => compile(c) }, runtime: null });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const common = { brief: 'A file-api test application.', template: 'knowledge', accent: 'blue' };
  const mkStatic = async (source = { 'index.html': '<h1>hi</h1>', 'app.js': 'const a = 1;' }) => (await req(base, 'POST', '/api/apps', { title: 'Static App', ...common, tier: 'static', source })).data.id;
  const outside = mkdtempSync(join(tmpdir(), 'pac-files-out-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const mkApp = async files => {
    const seed = mkdtempSync(join(tmpdir(), 'pac-files-seed-')); t.after(() => rmSync(seed, { recursive: true, force: true }));
    writeFileSync(join(seed, 'x'), 'x');
    const id = (await req(base, 'POST', '/api/apps', { title: 'Server App', ...common, tier: 'app', sourcePath: seed })).data.id;
    const wd = join(directory, 'generated', id); mkdirSync(wd, { recursive: true });
    for (const [p, c] of Object.entries(files)) { mkdirSync(join(wd, p, '..'), { recursive: true }); writeFileSync(join(wd, p), c); }
    const rev = store.state.apps.find(a => a.id === id).revision;
    const up = await req(base, 'POST', `/api/apps/${id}/definition`, { revision: rev, config: { title: 'Server App', ...common, tier: 'app', sourcePath: wd } });
    assert.equal(up.status, 200);
    return { id, wd };
  };
  return { base, store, mkStatic, mkApp, outside, directory };
}
const revOf = (store, id) => store.state.apps.find(a => a.id === id).revision;

test('FILES-001 static list/read/save bumps revision and stales a ready build', async t => {
  const { base, store, mkStatic } = await setup(t);
  const id = await mkStatic();
  const list = await req(base, 'GET', `/api/apps/${id}/files`);
  assert.equal(list.status, 200);
  assert.equal(list.data.editable, true);
  assert.deepEqual(list.data.files.map(f => f.path), ['app.js', 'index.html']);
  const f = await req(base, 'GET', `/api/apps/${id}/file?path=app.js`);
  assert.equal(f.data.language, 'javascript'); assert.equal(f.data.content, 'const a = 1;'); assert.equal(f.data.sha, sha('const a = 1;'));
  assert.equal((await req(base, 'GET', `/api/apps/${id}/file?path=nope.js`)).status, 404);
  await req(base, 'POST', `/api/apps/${id}/build`, {});
  for (let i = 0; i < 100 && store.state.apps[0].build?.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
  const app = store.state.apps.find(a => a.id === id);
  assert.equal(app.build.status, 'ready');
  const before = app.revision;
  const saved = await req(base, 'POST', `/api/apps/${id}/file`, { path: 'app.js', content: 'const a = 2;', baseSha: f.data.sha });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, before + 1); assert.deepEqual(saved.data.issues, []);
  assert.equal(app.config.source['app.js'], 'const a = 2;');
  assert.notEqual(app.build.revision, app.revision);
  assert.equal((await req(base, 'POST', `/api/apps/${id}/publish`, {})).status, 409);
  assert.ok(app.audit.some(a => /file edited: app\.js/.test(JSON.stringify(a))));
});

test('FILES-002 intent tier lists nothing; static forbidden code -> 422 and nothing stored', async t => {
  const { base, store, mkStatic } = await setup(t);
  const intent = (await req(base, 'POST', '/api/apps', { title: 'Intent App', brief: 'An intent-only application.', kind: 'interactive', accent: 'blue', tier: 'intent' })).data.id;
  const l = await req(base, 'GET', `/api/apps/${intent}/files`);
  assert.deepEqual(l.data, { tier: 'intent', files: [], editable: false, reason: 'Generate the application first' });
  const id = await mkStatic();
  const rev = revOf(store, id);
  for (const content of ['fetch("/x")', 'var u = "http://x";']) {
    const r = await req(base, 'POST', `/api/apps/${id}/file`, { path: 'app.js', content, baseSha: sha('const a = 1;') });
    assert.equal(r.status, 422); assert.ok(r.data.issues.length >= 1);
  }
  assert.equal(revOf(store, id), rev);
  assert.equal(store.state.apps.find(a => a.id === id).config.source['app.js'], 'const a = 1;');
  const bad = await req(base, 'POST', `/api/apps/${id}/file`, { path: 'x.exe', content: 'a', baseSha: null });
  assert.equal(bad.status, 400);
});

test('FILES-003 static conflicts, create, delete, rename, index.html protection', async t => {
  const { base, store, mkStatic } = await setup(t);
  const id = await mkStatic(), url = `/api/apps/${id}`;
  assert.equal((await req(base, 'POST', url + '/file', { path: 'app.js', content: 'x', baseSha: 'deadbeef' })).status, 409);
  assert.equal((await req(base, 'POST', url + '/file', { path: 'app.js', content: 'x', baseSha: null })).status, 409);
  const c = await req(base, 'POST', url + '/file', { path: 'style.css', content: 'b{}', baseSha: null });
  assert.equal(c.status, 200);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'style.css', to: 'main.css' })).status, 200);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'index.html', to: 'home.html' })).status, 400);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'main.css', to: 'app.js' })).status, 409);
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'index.html', baseSha: sha('<h1>hi</h1>') })).status, 400);
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'main.css', baseSha: 'bad' })).status, 409);
  const before = revOf(store, id);
  const d = await req(base, 'POST', url + '/file-delete', { path: 'main.css', baseSha: sha('b{}') });
  assert.equal(d.status, 200); assert.equal(d.data.revision, before + 1);
  assert.deepEqual(Object.keys(store.state.apps.find(a => a.id === id).config.source).sort(), ['app.js', 'index.html']);
});

test('FILES-004 app tier list/read, managed + ignored + symlinks + binary', async t => {
  const { base, mkApp, outside, store } = await setup(t);
  const { id, wd } = await mkApp({ 'Dockerfile': 'FROM scratch', 'src/main.py': 'print(1)', 'pac-ui.css': 'a{}', '.pac-manifest.json': '{}', 'node_modules/x/i.js': '1', 'bin.dat': '' });
  writeFileSync(join(wd, 'bin.dat'), Buffer.from([0xff, 0xfe, 0, 1]));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(wd, 'link'));
  symlinkSync(join(outside, 'secret.txt'), join(wd, 'sl.txt'));
  const url = `/api/apps/${id}`;
  const l = (await req(base, 'GET', url + '/files')).data;
  assert.equal(l.editable, true);
  assert.deepEqual(l.files.map(f => f.path), ['Dockerfile', 'bin.dat', 'pac-ui.css', 'src/main.py']);
  assert.deepEqual(l.files.find(f => f.path === 'pac-ui.css'), { path: 'pac-ui.css', size: 3, sha: sha('a{}'), readOnly: true, managed: true });
  assert.ok(!JSON.stringify(l).includes(wd));
  assert.equal((await req(base, 'GET', url + '/file?path=Dockerfile')).data.language, 'dockerfile');
  assert.equal((await req(base, 'GET', url + '/file?path=src/main.py')).data.language, 'python');
  assert.equal((await req(base, 'GET', url + '/file?path=bin.dat')).status, 415);
  assert.equal((await req(base, 'GET', url + '/file?path=sl.txt')).status, 403);
  assert.equal((await req(base, 'GET', url + '/file?path=link/secret.txt')).status, 403);
  assert.equal((await req(base, 'GET', url + '/file?path=../x')).status, 400);
  writeFileSync(join(wd, 'big.txt'), 'a'.repeat(1048577));
  assert.equal((await req(base, 'GET', url + '/file?path=big.txt')).status, 413);
  // writes
  const w = (path, content, baseSha = null) => req(base, 'POST', url + '/file', { path, content, baseSha });
  for (const p of ['../x', '/abs/x', 'a/../../x', 'a/..b/../../x']) assert.equal((await w(p, 'x')).status, 400, p);
  assert.equal((await w('link/pwn.txt', 'x')).status, 403);
  assert.equal((await w('sl.txt', 'x', sha('secret'))).status, 403);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret'); assert.ok(!existsSync(join(outside, 'pwn.txt')));
  assert.equal((await w('node_modules/y.js', 'x')).status, 403);
  assert.equal((await w('src/.git/y', 'x')).status, 403);
  assert.equal((await w('pac-ui.css', 'x', sha('a{}'))).status, 403);
  assert.equal((await w('pac-ui.json', 'x')).status, 403);
  assert.equal((await w('sub/.pac-manifest.json', 'x')).status, 403);
  assert.equal((await w('big.txt', 'a'.repeat(1048577), sha('a'.repeat(1048577)))).status, 413);
  assert.equal((await w('n.txt', 'a\0b')).status, 415);
  const before = revOf(store, id);
  const ok = await w('src/new/dir/n.txt', 'hello');
  assert.equal(ok.status, 200); assert.equal(ok.data.revision, before + 1); assert.equal(ok.data.sha, sha('hello'));
  assert.equal(readFileSync(join(wd, 'src/new/dir/n.txt'), 'utf8'), 'hello');
  assert.ok(!readdirSync(join(wd, 'src/new/dir')).some(n => n.startsWith('.pac-tmp')));
  assert.equal((await w('src/new/dir/n.txt', 'again')).status, 409);
  assert.equal((await w('src/new/dir/n.txt', 'again', 'stale')).status, 409);
  assert.equal((await w('src/new/dir/n.txt', 'again', sha('hello'))).status, 200);
  // rename/delete
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'src/new/dir/n.txt', to: '../z' })).status, 400);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'src/new/dir/n.txt', to: 'pac-ui.css' })).status, 403);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'pac-ui.css', to: 'q.css' })).status, 403);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'src/new/dir/n.txt', to: 'moved/n.txt' })).status, 200);
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'moved/n.txt', baseSha: sha('again') })).status, 200);
  assert.ok(!existsSync(join(wd, 'moved/n.txt')));
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'pac-ui.css', baseSha: sha('a{}') })).status, 403);
});

test('FILES-005 app tier with source outside the workdir is read-only', async t => {
  const { base, outside } = await setup(t);
  writeFileSync(join(outside, 'Dockerfile'), 'FROM scratch');
  const id = (await req(base, 'POST', '/api/apps', { title: 'Ext App', brief: 'An external source app.', template: 'knowledge', accent: 'blue', tier: 'app', sourcePath: outside })).data.id;
  const l = (await req(base, 'GET', `/api/apps/${id}/files`)).data;
  assert.equal(l.editable, false); assert.ok(l.reason); assert.equal(l.files[0].readOnly, true);
  assert.equal((await req(base, 'GET', `/api/apps/${id}/file?path=Dockerfile`)).data.readOnly, true);
  assert.equal((await req(base, 'POST', `/api/apps/${id}/file`, { path: 'Dockerfile', content: 'x', baseSha: sha('FROM scratch') })).status, 403);
});

test('FILES-006 refused while generating/building; collaborator cannot write', async t => {
  const { base, store, mkStatic } = await setup(t);
  const id = await mkStatic(), url = `/api/apps/${id}`, app = store.state.apps.find(a => a.id === id);
  const body = { path: 'app.js', content: 'const a = 3;', baseSha: sha('const a = 1;') };
  app.generation = { status: 'generating', logs: [] };
  assert.equal((await req(base, 'POST', url + '/file', body)).status, 409);
  app.generation = null; app.build = { status: 'building', logs: [] };
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'app.js', baseSha: body.baseSha })).status, 409);
  app.build = null;
  const tok = store.tokenSession({ kind: 'collaborator', label: 'Pat', appId: id });
  assert.equal((await req(base, 'GET', url + '/files', undefined, tok)).status, 200);
  assert.equal((await req(base, 'GET', url + '/file?path=app.js', undefined, tok)).status, 200);
  assert.equal((await req(base, 'POST', url + '/file', body, tok)).status, 403);
  assert.equal((await req(base, 'POST', url + '/file-rename', { from: 'app.js', to: 'b.js' }, tok)).status, 403);
  assert.equal((await req(base, 'POST', url + '/file-delete', { path: 'app.js', baseSha: body.baseSha }, tok)).status, 403);
  assert.equal(app.config.source['app.js'], 'const a = 1;');
});

test('FILES-007 file routes accept ~700KB bodies; other routes keep the 400KB cap', async t => {
  const { base, mkApp, mkStatic } = await setup(t);
  const { id } = await mkApp({ 'Dockerfile': 'FROM scratch' });
  const big = 'x'.repeat(700000);
  const r = await req(base, 'POST', `/api/apps/${id}/file`, { path: 'big.txt', content: big, baseSha: null });
  assert.equal(r.status, 200);
  const sid = await mkStatic();
  assert.equal((await req(base, 'POST', `/api/apps/${sid}/comments`, { text: big })).status, 413);
  assert.equal((await req(base, 'POST', `/api/apps/${id}/file`, { path: 'huge.txt', content: 'x'.repeat(1300000), baseSha: null })).status, 413);
});
