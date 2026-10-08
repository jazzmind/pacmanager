import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Same shape of path-safety check demo/definition.js's validateSource applies to inline
// source, applied here too even though these bytes end up on disk rather than embedded in
// state.json — a model-supplied relative path is untrusted input either way.
// Host-managed files the model may never write (pac-ui.* are written by the host before every generation).
const HOST_RE = /^(pac-ui\.[a-z]+|\.pac-manifest\.json)$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function assertSafeRelativePath(path) {
  if (path.includes('..') || path.startsWith('/') || !SAFE_PATH_RE.test(path)) throw new Error(`Unsafe file path in model output: ${path}`);
}

/** Turn the model's {kind, files} into the shape pacmanager's authoring output contract
 * expects: inline `source` for interactive/knowledge, or files actually written under
 * `workdir` (returned as `sourcePath`) for application. pacmanager itself still
 * realpath-verifies sourcePath is contained in workdir (demo/store.js) — this only has to not
 * write outside it in the first place. */
export function scaffold({ kind, files }, workdir) {
  if (kind !== 'application') return { source: files };
  if (!workdir) throw new Error('application kind requires a workdir to scaffold into');
  for (const path of Object.keys(files)) assertSafeRelativePath(path);
  const written = [];
  for (const [path, content] of Object.entries(files)) {
    if (HOST_RE.test(path)) continue; // never overwrite host-managed kit files
    const full = join(workdir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    written.push(path);
  }
  if (!existsSync(join(workdir, 'Dockerfile'))) throw new Error('application kind requires a Dockerfile at the project root, but the model did not provide one');
  // Files this scaffold wrote last time but the new output no longer has are stale: delete exactly those (never files absent from
  // the previous manifest, never host-managed files), then record this run's list.
  const manifestPath = join(workdir, '.pac-manifest.json');
  if (existsSync(manifestPath)) {
    let prev = [];
    try { const m = JSON.parse(readFileSync(manifestPath, 'utf8')); if (Array.isArray(m.files)) prev = m.files; } catch { /* unreadable manifest: delete nothing */ }
    for (const old of prev) {
      if (typeof old !== 'string' || written.includes(old) || HOST_RE.test(old) || old.includes('..') || old.startsWith('/') || !SAFE_PATH_RE.test(old)) continue;
      rmSync(join(workdir, old), { force: true });
    }
  }
  writeFileSync(manifestPath, JSON.stringify({ files: written.sort() }, null, 2) + '\n', 'utf8');
  return { sourcePath: workdir };
}
