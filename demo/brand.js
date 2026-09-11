import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Declarative brand pack loader. A brand pack is data, not a process: a directory with
 * brand.json (tokens + fonts + strings) and an assets/ directory (logo/icon SVGs). This is the
 * OSS side of pacmanager's branding seam — it loads whatever pack PAC_BRAND_PACK points at (or a
 * bundled neutral default so unbranded OSS renders exactly as it always has), validates it
 * fail-fast, and exposes cssVars()/t()/assetPath() for the demo server to use. PR-specific pack
 * contents (colors, logo, "PRAC Manager" naming) live in the pracman repo, never here — see
 * pracman/README.md's OSS/PR split table. Deliberately NOT a spawned adapter: rendering static
 * data on every page load shouldn't pay a process-spawn cost, and a pack should be reviewable as
 * a plain JSON diff. */

const DEFAULT_PACK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'brand', 'default');
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/;
const ALLOWED_TOP = new Set(['id', 'productName', 'productShort', 'organization', 'tagline', 'tokens', 'fonts', 'assets', 'accentChoices', 'strings', 'lint']);

function validate(dir, data) {
  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP.has(key)) throw new Error(`Brand pack error: unknown top-level key "${key}" in ${dir}/brand.json`);
  }
  for (const group of ['tokens', 'accentChoices']) {
    for (const [name, value] of Object.entries(data[group] || {})) {
      if (typeof value !== 'string' || !HEX.test(value)) throw new Error(`Brand pack error: ${group}.${name} is not a valid hex color: ${JSON.stringify(value)}`);
    }
  }
  const packRoot = resolve(dir) + sep;
  for (const [name, rel] of Object.entries(data.assets || {})) {
    if (typeof rel !== 'string') throw new Error(`Brand pack error: assets.${name} must be a string path`);
    const resolved = resolve(dir, rel);
    if (!resolved.startsWith(packRoot)) throw new Error(`Brand pack error: assets.${name} path escapes the pack directory: ${rel}`);
    if (!existsSync(resolved)) throw new Error(`Brand pack error: assets.${name} not found at ${resolved}`);
  }
}

function loadPackDir(dir) {
  const brandPath = resolve(dir, 'brand.json');
  if (!existsSync(brandPath)) throw new Error(`Brand pack error: no brand.json at ${dir}`);
  let data;
  try { data = JSON.parse(readFileSync(brandPath, 'utf8')); }
  catch (e) { throw new Error(`Brand pack error: invalid JSON in ${brandPath}: ${e.message}`); }
  validate(dir, data);
  return { dir: resolve(dir), data };
}

export function loadBrand(packDir = process.env.PAC_BRAND_PACK) {
  const { dir, data } = packDir ? loadPackDir(packDir) : loadPackDir(DEFAULT_PACK_DIR);
  return {
    dir,
    data,
    /** :root{--pac-brand:...;--pac-font-display:...} for a <link>/<style> the demo serves at /brand.css */
    cssVars() {
      const tokenLines = Object.entries(data.tokens || {}).map(([k, v]) => `--pac-${k}:${v};`).join('');
      const fonts = data.fonts || {};
      const fallback = fonts.fallback || 'sans-serif';
      const fontLines = `--pac-font-display:${fonts.display ? `'${fonts.display}',` : ''}${fallback};--pac-font-sans:${fonts.sans ? `'${fonts.sans}',` : ''}${fallback};`;
      return `:root{${tokenLines}${fontLines}}`;
    },
    /** String lookup with fallback; never throws on a missing key. */
    t(key, fallback) {
      return (data.strings && data.strings[key]) ?? fallback ?? key;
    },
    /** Resolved on-disk path for a named asset (logo, logoMono, appIcon, favicon), or null. */
    assetPath(name) {
      const rel = data.assets && data.assets[name];
      return rel ? resolve(dir, rel) : null;
    },
    /** The named accent options for create_application's `accent` field — replaces the two
     * previously-duplicated {teal,blue,plum} literals in definition.js (lines 60 and 171). */
    accentPalette() {
      return data.accentChoices || {};
    },
  };
}
