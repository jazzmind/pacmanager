import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join, relative, sep, basename, extname, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { definition, sha, sourceIssues } from './definition.js';
import { DEFAULT_IGNORE } from './tree-digest.js';
import { DemoError } from './store.js';

// Code-editor file API: pure functions over (store, principal, app). Reads need read access (the
// caller already did store.access); every write goes through store.access(p,id,true).
export const FILE_ROUTE_BODY_LIMIT = 1200000;
const MAX_FILE_BYTES = 1048576, MAX_LISTED = 500;
// Same regex as adapters/authoring/lib/scaffold.js (not exported there; copied rather than editing a file another agent owns).
const SAFE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const MANAGED_ROOT = new Set(['pac-ui.css', 'pac-ui.json']), MANIFEST = '.pac-manifest.json';
const fail = (status, message) => { throw new DemoError(status, message); };
const LANGS = { '.html': 'html', '.htm': 'html', '.css': 'css', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.md': 'markdown', '.py': 'python', '.sh': 'shell', '.bash': 'shell', '.yml': 'yaml', '.yaml': 'yaml' };
export const languageFor = path => { const b = basename(path); return /^Dockerfile/.test(b) ? 'dockerfile' : LANGS[extname(b).toLowerCase()] || 'text'; };
const isManaged = path => MANAGED_ROOT.has(path);
const decode = buf => { try { const t = new TextDecoder('utf-8', { fatal: true }).decode(buf); return t.includes('\0') ? null : t; } catch { return null; } };

/** The app's generated dir -- must mirror store.startGeneration's workdir. */
export function workdirFor(store, app) { return join(process.env.PAC_GENERATED_APPS_DIR || store.dataDir, 'generated', app.id); }

/** {root} when the app tier's sourcePath is a real dir inside the workdir; else {readOnly reason}. */
function appRoot(store, app) {
  const src = app.config.sourcePath;
  let real; try { real = realpathSync(src); } catch { return { root: null, reason: 'Source folder is not available' }; }
  let wd; try { wd = realpathSync(workdirFor(store, app)); } catch { return { root: real, reason: 'This application’s source lives outside the studio workspace; files are read-only' }; }
  if (real !== wd && !real.startsWith(wd + sep)) return { root: real, reason: 'This application’s source lives outside the studio workspace; files are read-only' };
  return { root: real, reason: null };
}

function walk(root, dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= MAX_LISTED) return;
    if (e.isSymbolicLink() || DEFAULT_IGNORE.has(e.name) || e.name === MANIFEST) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

export function listFiles(store, p, id) {
  const app = store.access(p, id), tier = app.config.tier;
  if (tier === 'static') {
    const files = Object.keys(app.config.source).sort().map(path => ({ path, size: Buffer.byteLength(app.config.source[path]), sha: sha(app.config.source[path]) }));
    return { tier, editable: true, files };
  }
  if (tier !== 'app') return { tier, files: [], editable: false, reason: 'Generate the application first' };
  const { root, reason } = appRoot(store, app);
  if (!root) return { tier, files: [], editable: false, reason };
  const paths = []; walk(root, root, paths);
  const files = paths.map(path => {
    const full = join(root, ...path.split('/')), size = lstatSync(full).size, f = { path, size, sha: null };
    if (size <= MAX_FILE_BYTES) f.sha = sha(readFileSync(full)); else f.readOnly = true;
    if (isManaged(path)) { f.managed = true; f.readOnly = true; } else if (reason) f.readOnly = true;
    return f;
  });
  const out = { tier, editable: !reason, files }; if (reason) out.reason = reason;
  if (paths.length >= MAX_LISTED) out.truncated = true;
  return out;
}

/** Validate a client path against the app tier's rules and return its absolute location. */
function appTarget(root, path, { forWrite = true } = {}) {
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/') || !SAFE_PATH_RE.test(path) || path.length > 300) fail(400, 'Unsafe file path');
  const parts = path.split('/');
  if (parts.some(s => !s)) fail(400, 'Unsafe file path');
  if (parts.some(s => DEFAULT_IGNORE.has(s))) fail(403, 'That directory is not editable');
  if (isManaged(path) || parts[parts.length - 1] === MANIFEST) fail(403, 'That file is managed by the studio and cannot be edited');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st; try { st = lstatSync(cur); } catch { break; } // not there yet: the rest will be created inside root
    if (st.isSymbolicLink()) fail(403, 'Symbolic links are not editable');
    if (i < parts.length - 1 && !st.isDirectory()) fail(409, 'A parent of that path is a file');
    if (i === parts.length - 1 && !st.isFile()) fail(409, 'Path is not a regular file');
  }
  const full = join(root, ...parts);
  if (!full.startsWith(root + sep)) fail(403, 'Path escapes the workspace');
  return full;
}

function readText(full) {
  const size = lstatSync(full).size;
  if (size > MAX_FILE_BYTES) fail(413, 'File is larger than 1MB');
  const text = decode(readFileSync(full));
  if (text === null) fail(415, 'Binary or non-UTF-8 files cannot be opened');
  return text;
}

export function readFile(store, p, id, path) {
  const app = store.access(p, id), tier = app.config.tier;
  if (typeof path !== 'string' || !path) fail(400, 'path is required');
  if (tier === 'static') {
    const c = app.config.source[path];
    if (c === undefined) fail(404, 'File not found');
    return { path, content: c, sha: sha(c), size: Buffer.byteLength(c), language: languageFor(path), readOnly: false };
  }
  if (tier !== 'app') fail(404, 'Generate the application first');
  const { root, reason } = appRoot(store, app);
  if (!root) fail(404, reason);
  if (path.includes('..') || path.startsWith('/') || !SAFE_PATH_RE.test(path)) fail(400, 'Unsafe file path');
  const parts = path.split('/');
  if (parts.some(s => DEFAULT_IGNORE.has(s)) || parts[parts.length - 1] === MANIFEST) fail(404, 'File not found');
  let cur = root;
  for (const s of parts) { cur = join(cur, s); let st; try { st = lstatSync(cur); } catch { fail(404, 'File not found'); } if (st.isSymbolicLink()) fail(403, 'Symbolic links are not readable'); }
  if (!lstatSync(cur).isFile()) fail(404, 'File not found');
  const content = readText(cur);
  return { path, content, sha: sha(content), size: Buffer.byteLength(content), language: languageFor(path), readOnly: Boolean(reason) || isManaged(path) };
}

function guardWrite(store, p, id) {
  const app = store.access(p, id, true);
  if (app.generation?.status === 'generating') fail(409, 'Generation is running; try again when it finishes');
  if (app.build?.status === 'building') fail(409, 'A build is running; try again when it finishes');
  if (app.config.tier !== 'static' && app.config.tier !== 'app') fail(409, 'Generate the application first');
  return app;
}
function appWritable(store, app) {
  const { root, reason } = appRoot(store, app);
  if (!root || reason) fail(403, reason || 'Source folder is not available');
  return root;
}
function commit(store, p, app, what) { app.revision++; store.audit(app, what, p); store.save(); return app.revision; }
const isShaOk = s => s === null || typeof s === 'string';

/** Static tier: apply a new source map through definition() (400 on structural rules) then the safety gate (422). */
function applyStatic(store, p, app, next, what) {
  let clean;
  try { clean = definition({ ...app.config, source: next }).source; } catch (e) { fail(400, e.message); }
  const issues = sourceIssues(clean);
  if (issues.length) throw Object.assign(new DemoError(422, 'Source rejected: ' + issues.join('; ')), { issues });
  app.config = definition({ ...app.config, source: clean });
  return commit(store, p, app, what);
}

export function saveFile(store, p, id, { path, content, baseSha } = {}) {
  const app = guardWrite(store, p, id);
  if (typeof path !== 'string' || typeof content !== 'string') fail(400, 'path and content are required');
  if (!isShaOk(baseSha) || baseSha === undefined) fail(400, 'baseSha must be a sha or null');
  const bytes = Buffer.from(content, 'utf8');
  if (app.config.tier === 'static') {
    const exists = Object.hasOwn(app.config.source, path), cur = exists ? sha(app.config.source[path]) : null;
    if (exists && baseSha === null) fail(409, 'File already exists; reopen it to edit');
    if (exists && baseSha !== cur) fail(409, 'File changed since you opened it');
    if (!exists && baseSha !== null) fail(409, 'File changed since you opened it');
    const revision = applyStatic(store, p, app, { ...app.config.source, [path]: content }, 'file edited: ' + path);
    return { path, sha: sha(content), size: bytes.length, revision, issues: [] };
  }
  const root = appWritable(store, app), full = appTarget(root, path);
  if (bytes.length > MAX_FILE_BYTES) fail(413, 'File is larger than 1MB');
  if (content.includes('\0') || bytes.toString('utf8') !== content) fail(415, 'Only UTF-8 text can be saved');
  const exists = existsSync(full);
  if (exists) { if (baseSha === null) fail(409, 'File already exists; reopen it to edit'); if (sha(readFileSync(full)) !== baseSha) fail(409, 'File changed since you opened it'); }
  else if (baseSha !== null) fail(409, 'File changed since you opened it');
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  // Re-check after creating parents: a component made by someone else in between must not be a link out of the root.
  appTarget(root, path);
  if (!realpathSync(dirname(full)).startsWith(root)) fail(403, 'Path escapes the workspace');
  const tmp = join(dirname(full), '.pac-tmp-' + randomBytes(6).toString('hex'));
  try { writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(tmp, full); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  const revision = commit(store, p, app, 'file edited: ' + path);
  return { path, sha: sha(bytes), size: bytes.length, revision, issues: [] };
}

export function deleteFile(store, p, id, { path, baseSha } = {}) {
  const app = guardWrite(store, p, id);
  if (typeof path !== 'string' || !isShaOk(baseSha) || baseSha === undefined) fail(400, 'path and baseSha are required');
  if (app.config.tier === 'static') {
    if (!Object.hasOwn(app.config.source, path)) fail(404, 'File not found');
    if (path === 'index.html') fail(400, 'index.html is required and cannot be deleted');
    if (baseSha !== sha(app.config.source[path])) fail(409, 'File changed since you opened it');
    const next = { ...app.config.source }; delete next[path];
    return { revision: applyStatic(store, p, app, next, 'file deleted: ' + path) };
  }
  const root = appWritable(store, app), full = appTarget(root, path);
  if (!existsSync(full)) fail(404, 'File not found');
  if (baseSha !== sha(readFileSync(full))) fail(409, 'File changed since you opened it');
  rmSync(full);
  return { revision: commit(store, p, app, 'file deleted: ' + path) };
}

export function renameFile(store, p, id, { from, to } = {}) {
  const app = guardWrite(store, p, id);
  if (typeof from !== 'string' || typeof to !== 'string' || from === to) fail(400, 'from and to must be two different paths');
  if (app.config.tier === 'static') {
    const src = app.config.source;
    if (!Object.hasOwn(src, from)) fail(404, 'File not found');
    if (from === 'index.html') fail(400, 'index.html is required and cannot be renamed');
    if (Object.hasOwn(src, to)) fail(409, 'A file with that name already exists');
    const next = { ...src }; next[to] = next[from]; delete next[from];
    return { revision: applyStatic(store, p, app, next, `file renamed: ${from} -> ${to}`) };
  }
  const root = appWritable(store, app), a = appTarget(root, from), b = appTarget(root, to);
  if (!existsSync(a)) fail(404, 'File not found');
  if (existsSync(b)) fail(409, 'A file with that name already exists');
  mkdirSync(dirname(b), { recursive: true, mode: 0o700 });
  appTarget(root, to);
  if (!realpathSync(dirname(b)).startsWith(root)) fail(403, 'Path escapes the workspace');
  renameSync(a, b);
  return { revision: commit(store, p, app, `file renamed: ${from} -> ${to}`) };
}
