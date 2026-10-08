import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildKitCss, contrast } from '../demo/ui-kit.js';
import { STYLE_PRESETS, STYLE_THEMES, STYLE_DENSITIES, STYLE_LAYOUTS, DEFAULT_STYLE, normalizeStyle } from '../demo/style-options.js';
import { definition, compile } from '../demo/definition.js';
import { Store } from '../demo/store.js';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';
import { loadBrand } from '../demo/brand.js';
import { writeKitFiles, readWorkdirSource } from '../demo/kit-files.js';

const owner = { kind: 'owner', label: 'Connected author' };
const brand = loadBrand();
const teal = brand.accentPalette().teal;
const combos = [];
for (const preset of STYLE_PRESETS) for (const theme of STYLE_THEMES) for (const density of STYLE_DENSITIES) for (const layout of STYLE_LAYOUTS) combos.push({ preset: preset.id, theme: theme.id, density: density.id, layout: layout.id });

test('KIT-001 every preset x theme x density x layout: no URLs, no </style, deterministic, < 64KB, distinct', () => {
  const seen = new Set();
  for (const style of combos) {
    const css = buildKitCss({ style, accentHex: teal, brand });
    assert.ok(!/https?:|\/\/|url\(|@import|@font-face/i.test(css.replace(/\/\*.*?\*\//g, '')), JSON.stringify(style));
    assert.ok(!/<\/style/i.test(css));
    assert.equal(css, buildKitCss({ style, accentHex: teal, brand }));
    assert.ok(Buffer.byteLength(css) < 64 * 1024, JSON.stringify(style));
    seen.add(css);
  }
  assert.equal(seen.size, combos.length);
});

test('KIT-002 normalizeStyle falls back per field and on unknown input', () => {
  assert.deepEqual(normalizeStyle(undefined), DEFAULT_STYLE);
  assert.deepEqual(normalizeStyle('x'), DEFAULT_STYLE);
  assert.deepEqual(normalizeStyle({ preset: 'bold', theme: 'nope' }), { ...DEFAULT_STYLE, preset: 'bold' });
});

test('KIT-003 scope prefixes every selector; :root/body map to the scope', () => {
  const css = buildKitCss({ style: { layout: 'sidebar', theme: 'auto' }, scope: '.kit-preview', brand });
  const sels = css.split('\n').filter(l => /\{/.test(l) && !l.startsWith('@media') && !l.startsWith('}')).map(l => l.slice(0, l.indexOf('{')));
  assert.ok(sels.length > 100);
  for (const s of sels) for (const part of s.split(',')) assert.ok(part === '.kit-preview' || part.startsWith('.kit-preview '), part);
  assert.ok(!/(^|[,\n])\s*(body|html|:root)\b/.test(css));
});

test('KIT-004 text/ink colours meet WCAG AA against surface in light and dark', () => {
  for (const hex of ['#136f63', '#79476f', '#f2c200', '#245a9e']) {
    const css = buildKitCss({ style: { theme: 'auto' }, accentHex: hex, brand });
    const [light, dark] = css.match(/--pac-surface:#[0-9a-f]{6};--pac-ink:#[0-9a-f]{6};--pac-muted:#[0-9a-f]{6};.*?--pac-accent:#[0-9a-f]{6}/g);
    for (const block of [light, dark]) {
      const g = k => block.match(new RegExp(`--pac-${k}:(#[0-9a-f]{6})`))[1];
      for (const k of ['ink', 'muted', 'accent']) assert.ok(contrast(g(k), g('surface')) >= 4.5, `${k} ${hex}`);
    }
  }
});

test('KIT-005 compileStatic injects the kit with the real accent hex and rejects nothing in the kit itself', () => {
  const cfg = { title: 'Kit App', brief: 'A brief of sufficient length.', kind: 'interactive', accent: 'plum', tier: 'static', source: { 'index.html': '<h1>hi</h1>', 'styles.css': '.x{color:red}' }, style: { preset: 'bold' } };
  const out = compile(cfg);
  assert.ok(out.html.includes(brand.accentPalette().plum));
  assert.ok(out.html.includes('--pac-hw:800'));
  assert.ok(out.html.indexOf('.pac-card') < out.html.indexOf('.x{color:red}'));
  assert.equal((out.html.match(/<style>/g) || []).length, 1);
  const none = compile({ ...cfg, style: undefined });
  assert.notEqual(none.sourceDigest, out.sourceDigest); // style participates in the digest
  assert.ok(none.html.includes('--pac-hw:650')); // default clean
});

test('KIT-006 definition validates style and rejects unknown values with a clear message', () => {
  const base = { title: 'Style App', brief: 'A brief of sufficient length.', kind: 'interactive', accent: 'teal', tier: 'intent' };
  assert.deepEqual(definition({ ...base, style: { preset: 'dashboard', layout: 'sidebar' } }).style, { ...DEFAULT_STYLE, preset: 'dashboard', layout: 'sidebar' });
  assert.throws(() => definition({ ...base, style: { preset: 'neon' } }), /style\.preset must be one of/);
  assert.throws(() => definition({ ...base, style: { colour: 'red' } }), /Unsupported style field/);
  assert.throws(() => definition({ ...base, style: 'bold' }), /style must be an object/);
  assert.equal(definition(base).style, undefined);
});

function storeFixture(t, authoring = null) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-kit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory, { mode: 'test', build: async c => compile(c) }, null, new Map(), authoring) };
}

test('KIT-007 a style change via setPlan bumps the revision, never generates, and rewrites pac-ui.css for an app-tier workdir', t => {
  const { directory, store } = storeFixture(t);
  const src = join(directory, 'proj'); mkdirSync(src);
  writeFileSync(join(src, 'Dockerfile'), 'FROM scratch');
  const app = store.create(owner, { title: 'App Tier', brief: 'A brief of sufficient length.', kind: 'application', accent: 'teal', tier: 'app', sourcePath: src });
  writeKitFiles(src, { style: app.config.style, accentHex: teal });
  const before = readFileSync(join(src, 'pac-ui.css'), 'utf8');
  const rev = app.revision;
  const res = store.setPlan(owner, app.id, { style: { preset: 'playful' }, accent: 'plum' });
  assert.equal(app.revision, rev + 1);
  assert.equal(app.generation, null);
  assert.equal(res.style.preset, 'playful');
  assert.equal(app.config.accent, 'plum');
  const after = readFileSync(join(src, 'pac-ui.css'), 'utf8');
  assert.notEqual(before, after);
  assert.ok(after.includes(brand.accentPalette().plum));
  assert.equal(JSON.parse(readFileSync(join(src, 'pac-ui.json'), 'utf8')).style.preset, 'playful');
  assert.throws(() => store.setPlan(owner, app.id, { style: { preset: 'nope' } }), e => e.status === 400);
  assert.equal(app.revision, rev + 1);
});

async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pac-kit-http-')), ownerToken = randomBytes(32).toString('hex');
  const runtime = createDemo({ directory, ownerToken, builder: createBuilder('process') });
  await new Promise(r => runtime.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + runtime.server.address().port;
  t.after(() => { runtime.server.closeAllConnections?.(); runtime.server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { base, ownerToken };
}

test('KIT-008 /ui-kit.css is public, validates params, honours scope; /style-options.js is served', async t => {
  const { base } = await httpFixture(t);
  const ok = await fetch(`${base}/ui-kit.css?preset=bold&theme=light&layout=sidebar&accent=plum&scope=.kit-preview`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/css/);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=300');
  const css = await ok.text();
  assert.ok(css.startsWith('.kit-preview{'));
  assert.ok(css.includes(brand.accentPalette().plum.slice(1, 3)));
  for (const q of ['preset=neon', 'theme=x', 'density=x', 'layout=x', 'accent=zzz', 'scope=a%20b', 'scope=..%2Fx', 'scope=' + 'a'.repeat(41)]) assert.equal((await fetch(`${base}/ui-kit.css?${q}`)).status, 400, q);
  assert.equal((await fetch(`${base}/ui-kit.css`)).status, 200);
  const so = await fetch(`${base}/style-options.js`);
  assert.equal(so.status, 200);
  assert.match(await so.text(), /export const STYLE_PRESETS/);
});

test('KIT-009 POST /api/apps accepts style and the plan route returns it', async t => {
  const { base, ownerToken } = await httpFixture(t);
  const call = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const created = await call('/api/apps', { title: 'Styled', brief: 'A brief of sufficient length.', kind: 'interactive', accent: 'teal', tier: 'intent', style: { preset: 'editorial' }, plan: 'my plan' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const r = await call(`/api/apps/${id}/plan`, { style: { layout: 'single' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.style, { ...DEFAULT_STYLE, preset: 'editorial', layout: 'single' });
  assert.equal((await call(`/api/apps/${id}/plan`, { style: { layout: 'diagonal' } })).status, 400);
});

// ---- app-tier revisions -----------------------------------------------------------------------

function fakeAuthoring(output) {
  const calls = [];
  return { mode: 'fake', calls, async generate(a) { calls.push(a); return { status: 'ok', output: { ...output, sourcePath: this.output } }; }, async probe() { return { status: 'ok', output: { model: 'm' } }; } };
}
function appFixture(t, authoringFor) {
  const { directory, store: s0 } = storeFixture(t);
  const wd = join(directory, 'wd'); mkdirSync(wd);
  writeFileSync(join(wd, 'Dockerfile'), 'FROM node:22');
  writeFileSync(join(wd, 'server.js'), 'console.log(1)');
  const authoring = fakeAuthoring(authoringFor(wd));
  const store = new Store(directory, { mode: 'test', build: async c => compile(c) }, null, new Map(), authoring);
  const app = store.create(owner, { title: 'App Tier', brief: 'A brief of sufficient length.', kind: 'application', accent: 'teal', tier: 'app', sourcePath: wd });
  // A real app-tier app lives in <dataDir>/generated/<id>; move the fixture files there so containment checks hold.
  const real = join(directory, 'generated', app.id); mkdirSync(real, { recursive: true });
  for (const f of ['Dockerfile', 'server.js']) writeFileSync(join(real, f), readFileSync(join(wd, f)));
  app.config.sourcePath = real;
  authoring.output = real;
  return { store, app, authoring, wd: real };
}

test('KIT-010 app-tier revise sends currentSource (no pac-ui files) + changeRequest and writes the kit before generating', async t => {
  const { store, app, authoring, wd } = appFixture(t, () => ({ kind: 'application', model: 'm', sourcePath: null }));
  writeFileSync(join(wd, 'pac-ui.css'), 'stale');
  await assert.rejects(store.startGeneration(owner, app.id, {}), e => e.status === 400); // changeRequest required
  await store.startGeneration(owner, app.id, { changeRequest: 'Add a footer' });
  await store.lastGeneration;
  const payload = authoring.calls[0].payload;
  assert.equal(payload.changeRequest, 'Add a footer');
  assert.deepEqual(Object.keys(payload.currentSource).sort(), ['Dockerfile', 'server.js']);
  assert.equal(payload.style, null);
  assert.equal(payload.accentHex, teal);
  assert.ok(readFileSync(join(wd, 'pac-ui.css'), 'utf8').includes('.pac-card'));
  assert.equal(app.generation.status, 'ready');
});

test('KIT-011 over-cap workdir falls back to regenerate-from-plan with a log line', async t => {
  const { store, app, authoring, wd } = appFixture(t, () => ({ kind: 'application', model: 'm', sourcePath: null }));
  writeFileSync(join(wd, 'big.txt'), 'x'.repeat(100001));
  assert.ok(readWorkdirSource(wd).overCap);
  await store.startGeneration(owner, app.id, { changeRequest: 'Tweak' });
  await store.lastGeneration;
  const payload = authoring.calls[0].payload;
  assert.equal(payload.currentSource, null);
  assert.match(payload.brief, /Change to apply: Tweak/);
  assert.ok(app.generation.logs.some(l => /too large/.test(l.text)));
});

test('KIT-012 readWorkdirSource skips ignored dirs, host files and binaries', t => {
  const d = mkdtempSync(join(tmpdir(), 'pac-rws-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, 'node_modules')); writeFileSync(join(d, 'node_modules', 'x.js'), 'x');
  writeFileSync(join(d, 'a.js'), 'a'); writeFileSync(join(d, 'pac-ui.css'), 'k'); writeFileSync(join(d, '.pac-manifest.json'), '{}'); writeFileSync(join(d, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(readWorkdirSource(d), { source: { 'a.js': 'a' } });
});
