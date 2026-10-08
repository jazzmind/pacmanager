import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKitCss } from './ui-kit.js';
import { loadBrand } from './brand.js';
import { normalizeStyle } from './style-options.js';
import { treeDigest } from './tree-digest.js';

/** Host-managed files in an app-tier workdir. The model must never write or overwrite these. */
export const HOST_FILES = ['pac-ui.css', 'pac-ui.json', '.pac-manifest.json'];
const brand = loadBrand();

/** Write pac-ui.css (the full, unscoped kit) and pac-ui.json (tokens + style) into a workdir. */
export function writeKitFiles(workdir, { style, accentHex } = {}) {
  const st = normalizeStyle(style);
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workdir, 'pac-ui.css'), buildKitCss({ style: st, accentHex, brand }), 'utf8');
  const tokens = { ...(brand.data.tokens || {}), accent: accentHex || (brand.data.tokens || {}).accent };
  writeFileSync(join(workdir, 'pac-ui.json'), JSON.stringify({ style: st, accent: accentHex || null, tokens, fonts: brand.data.fonts || {} }, null, 2) + '\n', 'utf8');
}

export const REVISE_CAPS = { files: 25, total: 300000, perFile: 100000 };
/** Read a workdir's text files as {path: text} for a revision. Returns {source} or {overCap:reason} (caller falls back to
 * regenerating from the plan). Skips ignored dirs (via treeDigest), host-managed files, and binary / non-UTF8 files. */
export function readWorkdirSource(root, caps = REVISE_CAPS) {
  let files;
  try { files = treeDigest(root).files; } catch { return { source: {} }; }
  const source = {};
  let total = 0, count = 0;
  for (const rel of files) {
    if (HOST_FILES.includes(rel)) continue;
    const buf = readFileSync(join(root, ...rel.split('/')));
    if (buf.includes(0) || !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) continue;
    if (buf.length > caps.perFile) return { overCap: `${rel} is larger than ${caps.perFile} bytes` };
    total += buf.length; count++;
    if (count > caps.files) return { overCap: `more than ${caps.files} files` };
    if (total > caps.total) return { overCap: `more than ${caps.total} bytes of source` };
    source[rel] = buf.toString('utf8');
  }
  return { source };
}
