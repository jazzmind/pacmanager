import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Same shape of path-safety check demo/definition.js's validateSource applies to inline
// source, applied here too even though these bytes end up on disk rather than embedded in
// state.json — a model-supplied relative path is untrusted input either way.
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
  for (const [path, content] of Object.entries(files)) {
    const full = join(workdir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  if (!existsSync(join(workdir, 'Dockerfile'))) throw new Error('application kind requires a Dockerfile at the project root, but the model did not provide one');
  return { sourcePath: workdir };
}
