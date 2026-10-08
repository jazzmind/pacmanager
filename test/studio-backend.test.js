import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';
import { createAuthoringAdapter } from '../demo/authoring-adapter.js';
import { completeChat } from '../demo/litellm.js';
import { definition } from '../demo/definition.js';
import { Store } from '../demo/store.js';

// Studio UX backend: cancel generation, chat timeout + SSE streaming, persisted plans, AI-led drafts, static allowlist.

const slowAdapter = fileURLToPath(new URL('../demo/fixtures/slow-authoring-adapter.js', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const okAuthoring = (source = { 'index.html': '<h1>hi</h1>' }) => ({ mode: 'fake', async generate() { return { status: 'ok', output: { kind: 'interactive', model: 'm', source } }; }, async probe() { return { status: 'ok', output: { model: 'm' } }; } });

async function fixture(t, { env, authoring = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-studio-')), ownerToken = randomBytes(32).toString('hex');
  const restore = {};
  for (const [k, v] of Object.entries(env || {})) { restore[k] = process.env[k]; process.env[k] = v; }
  const runtime = createDemo({ directory, ownerToken, builder: createBuilder('process'), authoring });
  await new Promise(r => runtime.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + runtime.server.address().port;
  t.after(() => { runtime.server.closeAllConnections?.(); runtime.server.close(); rmSync(directory, { recursive: true, force: true }); for (const [k, v] of Object.entries(restore)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const raw = (path, body, headers = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + ownerToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (path, body) => { const res = await raw(path, body); const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: res.status, data }; };
  return { runtime, call, raw, base, directory, ownerToken };
}

const intent = { title: 'Studio App', brief: 'An arcade game, insurance themed.', kind: 'interactive', accent: 'teal', tier: 'intent' };
const classic = { title: 'Chat App', brief: 'Exercises the chat endpoint.', template: 'claims', accent: 'teal' };

/** Fake LiteLLM: `handler(body, res, req)` may take over the response; otherwise a plain JSON completion of its return value. */
function fakeLitellm(handler) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => { const parsed = JSON.parse(body || '{}'); s.requests.push(parsed); const out = handler(parsed, res, req); if (out !== undefined) res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: out }, finish_reason: 'stop' }] })); });
    });
    s.requests = [];
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const llmEnv = s => ({ PAC_LITELLM_URL: `http://127.0.0.1:${s.address().port}` });

// ---- cancel generation ------------------------------------------------------------------------

test('CANCEL-001 cancel kills the adapter child, marks cancelled, leaves config untouched, and frees the slot', async t => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'pac-pid-')), 'pid');
  const env = { SLOW_PID_FILE: pidFile };
  const authoring = createAuthoringAdapter({ PAC_AUTHORING_ADAPTER: `node ${slowAdapter}`, PAC_AUTHORING_ADAPTER_TIMEOUT_MS: '60000' });
  const { runtime, call } = await fixture(t, { env, authoring });
  const created = await call('/api/apps', intent);
  assert.equal((await call(`/api/apps/${created.data.id}/generate/cancel`, {})).status, 409); // idle
  assert.equal((await call(`/api/apps/${created.data.id}/generate`, {})).status, 202);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  const mid = (await call('/api/apps/' + created.data.id)).data.generation;
  assert.equal(mid.currentAttempt, 1); assert.equal(mid.maxAttempts, 3); assert.ok(mid.startedAt);
  const cancelled = await call(`/api/apps/${created.data.id}/generate/cancel`, {});
  assert.deepEqual(cancelled.data, { id: mid.id, status: 'cancelled' });
  await runtime.store.lastGeneration;
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false);
  const app = (await call('/api/apps/' + created.data.id)).data;
  assert.equal(app.generation.status, 'cancelled');
  assert.match(app.generation.logs.at(-1).text, /Stopped by Connected author/);
  assert.equal(app.config.tier, 'intent'); assert.equal(app.revision, 1);
  assert.ok(app.audit.some(a => a.event === 'generation.cancelled'));
  assert.equal(runtime.store.generating, 0);
  assert.equal((await call(`/api/apps/${created.data.id}/generate/cancel`, {})).status, 409);
  runtime.store.authoring = okAuthoring(); // a new generation can start afterwards
  assert.equal((await call(`/api/apps/${created.data.id}/generate`, {})).status, 202);
  await runtime.store.lastGeneration;
  assert.equal((await call('/api/apps/' + created.data.id)).data.generation.status, 'ready');
});

test('CANCEL-002 cancel_generation MCP tool and a plan linked to a cancelled generation returns to draft', async t => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'pac-pid-')), 'pid');
  const authoring = createAuthoringAdapter({ PAC_AUTHORING_ADAPTER: `node ${slowAdapter}`, PAC_AUTHORING_ADAPTER_TIMEOUT_MS: '60000' });
  const { runtime, call, raw } = await fixture(t, { env: { SLOW_PID_FILE: pidFile }, authoring });
  const created = await call('/api/apps', intent);
  await call(`/api/apps/${created.data.id}/generate`, { plan: '# Plan\nBuild it.' });
  assert.equal((await call('/api/apps/' + created.data.id)).data.plan.status, 'executing');
  const rpc = await (await raw('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cancel_generation', arguments: { id: created.data.id } } })).json();
  assert.equal(JSON.parse(rpc.result.content[0].text).status, 'cancelled');
  await runtime.store.lastGeneration;
  assert.equal((await call('/api/apps/' + created.data.id)).data.plan.status, 'draft');
});

// ---- chat timeout + SSE -----------------------------------------------------------------------

test('CHATSSE-001 completeChat times out against a hanging gateway (PAC_CHAT_TIMEOUT_MS)', async t => {
  const hang = await fakeLitellm(() => undefined); t.after(() => { hang.closeAllConnections(); hang.close(); });
  const started = Date.now();
  await assert.rejects(completeChat({ messages: [{ role: 'user', content: 'hi' }] }, { ...llmEnv(hang), PAC_CHAT_TIMEOUT_MS: '50' }), e => e.status === 502 && /timed out/.test(e.message));
  assert.ok(Date.now() - started < 3000);
});

const sseUpstream = (chunks, { hold = false } = {}) => (body, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (!hold) { res.write('data: [DONE]\n\n'); res.end(); }
};
const delta = (content, extra = {}) => ({ model: 'fake-model', choices: [{ delta: { content, ...extra } }] });

function parseSse(text) { return text.split('\n\n').filter(b => b.startsWith('event:')).map(b => { const [e, d] = b.split('\n'); return { event: e.slice(7), data: JSON.parse(d.slice(6)) }; }); }

test('CHATSSE-002 SSE chat streams ordered deltas, ignores reasoning, persists only at done, echoes nonce', async t => {
  const fake = await fakeLitellm(sseUpstream([delta('', { reasoning_content: 'thinking' }), delta('Hel'), delta('lo '), delta('world'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  t.after(() => fake.close());
  const { call, raw } = await fixture(t, { env: llmEnv(fake) });
  const created = await call('/api/apps', classic);
  const res = await raw(`/api/apps/${created.data.id}/chat`, { mode: 'chat', message: 'Hi?', nonce: 'n-1' }, { Accept: 'text/event-stream' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const events = parseSse(await res.text());
  assert.equal(fake.requests[0].stream, true);
  assert.deepEqual(events.slice(0, -1).map(e => e.data.text), ['Hel', 'lo ', 'world']);
  const done = events.at(-1);
  assert.equal(done.event, 'done'); assert.equal(done.data.reply, 'Hello world'); assert.equal(done.data.nonce, 'n-1');
  const log = (await call('/api/apps/' + created.data.id)).data.chatLog;
  assert.equal(log.length, 1); assert.equal(log[0].id, done.data.id);
});

test('CHATSSE-003 client abort cancels the upstream call and persists nothing', async t => {
  let upstreamClosed;
  const closed = new Promise(r => { upstreamClosed = r; });
  const fake = await fakeLitellm((body, res, req) => { res.on('close', () => upstreamClosed(true)); sseUpstream([delta('partial')], { hold: true })(body, res); });
  t.after(() => { fake.closeAllConnections(); fake.close(); });
  const { call, base, ownerToken } = await fixture(t, { env: llmEnv(fake) });
  const created = await call('/api/apps', classic);
  const ac = new AbortController();
  const res = await fetch(`${base}/api/apps/${created.data.id}/chat`, { method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ mode: 'chat', message: 'Hi?' }), signal: ac.signal });
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /partial/);
  ac.abort();
  assert.equal(await Promise.race([closed, sleep(3000).then(() => false)]), true);
  await sleep(100);
  assert.equal((await call('/api/apps/' + created.data.id)).data.chatLog.length, 0);
});

test('CHATSSE-004 SSE errors arrive as an error event; the plain JSON path is unchanged and echoes nonce', async t => {
  const fake = await fakeLitellm(body => 'plain reply'); t.after(() => fake.close());
  const { call, raw } = await fixture(t, { env: llmEnv(fake) });
  const created = await call('/api/apps', classic);
  const bad = parseSse(await (await raw(`/api/apps/${created.data.id}/chat`, { mode: 'nope', message: 'x' }, { Accept: 'text/event-stream' })).text());
  assert.equal(bad[0].event, 'error'); assert.equal(bad[0].data.status, 400);
  const json = await call(`/api/apps/${created.data.id}/chat`, { mode: 'chat', message: 'Hi?', nonce: 'abc' });
  assert.equal(json.status, 200); assert.equal(json.data.reply, 'plain reply'); assert.equal(json.data.nonce, 'abc');
});

// ---- plans ------------------------------------------------------------------------------------

test('PLAN-001 Plan-mode chat (JSON and SSE) stores a draft plan that survives a reload; POST /plan edits and discards', async t => {
  const fake = await fakeLitellm((body, res) => body.stream ? sseUpstream([delta('1. Add a chart\n2. Add export')])(body, res) : '1. Add a chart\n2. Add export'); t.after(() => fake.close());
  const { runtime, call, raw, directory } = await fixture(t, { env: llmEnv(fake) });
  const created = await call('/api/apps', classic);
  const id = created.data.id;
  assert.equal((await call(`/api/apps/${id}/chat`, { mode: 'chat', message: 'q' })).status, 200);
  assert.equal((await call('/api/apps/' + id)).data.plan, null); // chat mode never makes a plan
  await call(`/api/apps/${id}/chat`, { mode: 'plan', message: 'add a chart' });
  let plan = (await call('/api/apps/' + id)).data.plan;
  assert.equal(plan.status, 'draft'); assert.match(plan.text, /Add a chart/); assert.ok(plan.at);
  assert.equal((await call('/api/apps')).data[0].plan.status, 'draft');
  const reloaded = new Store(directory, runtime.store.builder);
  assert.equal(reloaded.state.apps[0].plan.text, plan.text);
  const edited = await call(`/api/apps/${id}/plan`, { text: 'Edited plan' });
  assert.equal(edited.status, 200); assert.equal(edited.data.text, 'Edited plan'); assert.equal(edited.data.status, 'draft');
  assert.equal((await call(`/api/apps/${id}/plan`, { status: 'discarded' })).data.status, 'discarded');
  assert.equal((await call(`/api/apps/${id}/plan`, { status: 'bogus' })).status, 400);
  assert.equal((await call(`/api/apps/${id}/plan`, { text: '' })).status, 400);
  assert.equal((await call(`/api/apps/${id}/plan`, { text: 'x'.repeat(20001) })).status, 400);
  await raw(`/api/apps/${id}/chat`, { mode: 'plan', message: 'again' }, { Accept: 'text/event-stream' }).then(r => r.text());
  assert.equal((await call('/api/apps/' + id)).data.plan.status, 'draft'); // SSE path sets it too
});

test('PLAN-002 a changeRequest equal to the draft plan marks it executing then executed; a fresh app takes the plan in the adapter brief only', async t => {
  const seen = [];
  const states = []; let store;
  const authoring = { mode: 'fake', async generate(a) { states.push(store.state.apps[0].plan.status); seen.push(a.payload); return { status: 'ok', output: { kind: 'interactive', model: 'm', source: { 'index.html': '<h1>' + seen.length + '</h1>' } } }; }, async probe() { return { status: 'ok', output: {} }; } };
  const { runtime, call } = await fixture(t, { authoring }); store = runtime.store;
  const created = await call('/api/apps', intent), id = created.data.id;
  await call(`/api/apps/${id}/generate`, { plan: 'PLAN BODY' });
  await runtime.store.lastGeneration;
  let app = (await call('/api/apps/' + id)).data;
  assert.equal(app.plan.status, 'executed'); assert.equal(app.config.brief, intent.brief);
  assert.equal(seen[0].brief, intent.brief + '\n\nApproved build plan (follow it):\nPLAN BODY');
  runtime.store.setPlan({ kind: 'owner', label: 'o' }, id, { text: 'Make it blue', status: 'draft' });
  await call(`/api/apps/${id}/generate`, { changeRequest: 'Make it blue' });
  await runtime.store.lastGeneration;
  assert.deepEqual(states, ['executing', 'executing']);
  assert.equal((await call('/api/apps/' + id)).data.plan.status, 'executed');
  assert.equal(seen[1].changeRequest, 'Make it blue');
});

// ---- drafts -----------------------------------------------------------------------------------

const draftJson = over => JSON.stringify({ title: 'Claims Intake', summary: 'Collect claims notes.', capabilities: [{ id: 'documents', why: 'search files' }, { id: 'export-data', why: 'csv' }, { id: 'bogus', why: 'x' }, { id: 'web-search', why: 'look up' }], unavailable: [], kindRationale: 'Needs a database.', plan: '## Plan\nBuild it.', questions: ['Who uses it?'], ...over });

test('DRAFT-001 draft normalises: unknown dropped, future moved to unavailable, implied added, kind and envRefs derived', async t => {
  const fake = await fakeLitellm(() => '```json\n' + draftJson() + '\n```'); t.after(() => fake.close());
  const { call } = await fixture(t, { env: { ...llmEnv(fake), PAC_DRAFT_MODEL: 'drafter' } });
  const res = await call('/api/drafts', { brief: 'Collect claim notes and search them.' });
  assert.equal(res.status, 200);
  assert.equal(fake.requests[0].model, 'drafter'); assert.equal(fake.requests[0].max_tokens, 3000);
  assert.match(fake.requests[0].messages[0].content, /UNAVAILABLE/);
  assert.deepEqual(res.data.capabilities.map(c => c.id), ['documents', 'export-data', 'shared-data']);
  assert.equal(res.data.capabilities[2].implied, true);
  assert.deepEqual(res.data.unavailable.map(c => c.id), ['web-search']);
  assert.equal(res.data.kind, 'application');
  assert.deepEqual(res.data.envRefs, { DATABASE_URL: 'pgvector' });
  assert.equal(res.data.title, 'Claims Intake'); assert.deepEqual(res.data.questions, ['Who uses it?']);
});

test('DRAFT-002 tolerates surrounding prose, derives a static kind, and validates input', async t => {
  const fake = await fakeLitellm(() => 'Sure! Here you go: ' + draftJson({ capabilities: [{ id: 'analyze', why: 'charts' }], title: 'x'.repeat(200), summary: 's'.repeat(900) }) + ' Hope that helps.'); t.after(() => fake.close());
  const { call } = await fixture(t, { env: llmEnv(fake) });
  const res = await call('/api/drafts', { brief: 'A simple chart page for totals.', history: [{ role: 'user', content: 'static is fine' }] });
  assert.equal(res.data.kind, 'interactive'); assert.deepEqual(res.data.envRefs, {});
  assert.equal(res.data.title.length, 80); assert.equal(res.data.summary.length, 500);
  assert.equal((await call('/api/drafts', { brief: 'short' })).status, 400);
  assert.equal((await call('/api/drafts', { brief: 'long enough brief', history: [{ role: 'system', content: 'x' }] })).status, 400);
});

test('DRAFT-003 bad JSON is repaired once with the parse error fed back; still bad gives a 502', async t => {
  let n = 0;
  const fake = await fakeLitellm(() => ++n === 1 ? 'not json at all' : draftJson({ capabilities: [] })); t.after(() => fake.close());
  const { call } = await fixture(t, { env: llmEnv(fake) });
  const res = await call('/api/drafts', { brief: 'Something to draft please.' });
  assert.equal(res.status, 200); assert.equal(fake.requests.length, 2);
  assert.match(fake.requests[1].messages.at(-1).content, /could not be parsed: no JSON object found/);
  const bad = await fakeLitellm(() => 'nope'); t.after(() => bad.close());
  const f2 = await fixture(t, { env: llmEnv(bad) });
  const r2 = await f2.call('/api/drafts', { brief: 'Something to draft please.' });
  assert.equal(r2.status, 502); assert.match(r2.data.error, /did not return a usable draft/); assert.equal(bad.requests.length, 2);
});

test('DRAFT-004 definition rejects future capabilities and a kind that disagrees with the capabilities', () => {
  const base = { title: 'Some App', brief: 'A brief that is long enough.', accent: 'teal', tier: 'intent' };
  assert.throws(() => definition({ ...base, kind: 'interactive', capabilities: ['web-search'] }), /not available yet/);
  assert.throws(() => definition({ ...base, kind: 'interactive', capabilities: ['shared-data'] }), /does not match.*"application"/);
  assert.throws(() => definition({ ...base, kind: 'application', capabilities: ['analyze'] }), /does not match.*"interactive"/);
  assert.equal(definition({ ...base, kind: 'auto', capabilities: ['shared-data'] }).kind, 'auto');
  assert.equal(definition({ ...base, kind: 'application', capabilities: [] }).kind, 'application');
  assert.equal(definition({ ...base, kind: 'application', capabilities: ['documents'] }).kind, 'application');
  assert.equal(definition({ ...base, kind: 'knowledge', capabilities: ['briefings'] }).kind, 'knowledge');
});

// ---- static allowlist -------------------------------------------------------------------------

test('STATIC-001 allowlisted assets are routable (404 only when the file is absent); nothing else under /vendor or traversal is served', async t => {
  const { raw } = await fixture(t);
  assert.equal((await raw('/ui.js')).status, 200);
  const web = new URL('../demo/web/', import.meta.url);
  for (const p of ['/art.js', '/vendor/marked.min.js', '/vendor/purify.min.js', '/vendor/LICENSE-marked.txt', '/vendor/LICENSE-purify.txt']) {
    const res = await raw(p);
    if (existsSync(new URL('.' + p, web))) { assert.equal(res.status, 200, p); assert.match(res.headers.get('content-type'), p.endsWith('.txt') ? /text\/plain/ : /text\/javascript/); }
    else assert.equal(res.status, 404, p);
  }
  for (const p of ['/vendor/other.js', '/%2e%2e/server.js', '/vendor/']) assert.notEqual((await raw(p)).status, 200, p);
});
