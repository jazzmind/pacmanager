import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrand } from '../demo/brand.js';

// The branding seam (demo/brand.js + the two shipped packs + demo/web/style.css's consumption
// of it) previously had zero automated coverage -- every validation-failure case and the
// no-bare-hex-literals discipline were verified live, by hand, not pinned by a test. See
// docs/implementation-status.md's "Branding and sign-out" section.

function fixture(t, tokens = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-brand-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'logo.png'), 'fake-png-bytes');
  const data = {
    id: 'test-pack', productName: 'Test', productShort: 'T', organization: 'Test Org', tagline: 'Testing.',
    tokens: { brand: '#112233', surface: '#ffffff', ...tokens },
    fonts: { display: 'Inter', sans: 'Inter', fallback: 'sans-serif' },
    assets: { logo: 'assets/logo.png' },
    accentChoices: { teal: '#136f63' },
    strings: {}, lint: {}, accentLabels: {},
    ...extra,
  };
  writeFileSync(join(dir, 'brand.json'), JSON.stringify(data));
  return dir;
}

test('BRAND-001 the bundled default pack loads and validates cleanly', () => {
  const brand = loadBrand();
  assert.equal(brand.data.id, 'pac-manager-default');
});

test('BRAND-002 cssVars() emits every token (including sunken/hover/badge) as a --pac-<name> declaration, plus both font vars', () => {
  const brand = loadBrand();
  const css = brand.cssVars();
  for (const key of Object.keys(brand.data.tokens)) assert.match(css, new RegExp(`--pac-${key}:${brand.data.tokens[key].replace('#', '\\#')};`));
  assert.match(css, /--pac-font-display:/);
  assert.match(css, /--pac-font-sans:/);
});

test('BRAND-003 an invalid hex token value fails closed at load time, not silently at render time', t => {
  const dir = fixture(t, { warn: 'not-a-color' });
  assert.throws(() => loadBrand(dir), /not a valid hex color/);
});

test('BRAND-004 an unknown top-level key is rejected', t => {
  const dir = fixture(t, {}, { extraTopLevelJunk: 'nope' });
  assert.throws(() => loadBrand(dir), /unknown top-level key/);
});

test('BRAND-005 an asset path escaping the pack directory is rejected', t => {
  const dir = fixture(t, {}, { assets: { logo: '../../etc/passwd' } });
  assert.throws(() => loadBrand(dir), /escapes the pack directory/);
});

test('BRAND-006 an asset path that does not exist on disk is rejected', t => {
  const dir = fixture(t, {}, { assets: { logo: 'assets/missing.png' } });
  assert.throws(() => loadBrand(dir), /not found/);
});

test('BRAND-007 t() falls back to the supplied default, then the key itself, never throwing on a missing string', () => {
  const brand = loadBrand();
  assert.equal(brand.t('does.not.exist', 'fallback text'), 'fallback text');
  assert.equal(brand.t('does.not.exist'), 'does.not.exist');
});

test('BRAND-008 assetPath() returns null for an asset the pack never declared', () => {
  const brand = loadBrand();
  assert.equal(brand.assetPath('nonexistentAssetName'), null);
});

test('BRAND-009 accentLabel() falls back to a capitalized key for a pack that only supplies accentChoices', t => {
  const dir = fixture(t, {}, { accentChoices: { midnight: '#101020' }, accentLabels: {} });
  const brand = loadBrand(dir);
  assert.equal(brand.accentLabel('midnight'), 'Midnight');
});

// The actual regression guard: no bare hex color literal may reappear in style.css except as
// the fallback half of an already-tokenized var(--pac-X,#hex) declaration, or the one
// deliberately-literal white-text-on-dark-toast case documented inline. Catches exactly the
// kind of drift this pass fixed (45 untokenized literals) from silently coming back.
test('BRAND-010 style.css has no bare hex color literal outside a var(--pac-*, #fallback) declaration', () => {
  const css = readFileSync(new URL('../demo/web/style.css', import.meta.url), 'utf8');
  const bareHex = [...css.matchAll(/(?<!var\(--pac-[a-z-]+,)#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  // The one intentional exception: white text on the #toast's dark (--pac-ink) background --
  // a text-contrast choice, not a surface/border color this pass's tokens cover.
  const unexpected = bareHex.filter(h => h !== '#fff');
  assert.deepEqual(unexpected, []);
});
