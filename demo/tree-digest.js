import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

/** Directories never worth digesting: build output, dependency caches and VCS metadata.
 * Deliberately the same practical exclude set deploykit's own rsync uses
 * (vscode/src/commands/deployApp.ts rsyncToSandbox) rather than a bespoke list, and
 * deliberately NOT a full .gitignore parser — that's a documented limitation, not an
 * oversight: a real .gitignore can express patterns (negation, nested globs) this
 * fixed list can't, so a repo relying on unusual ignore rules may digest more than
 * expected. Callers that need exact parity with `git ls-files` should pass `extraIgnore`. */
const DEFAULT_IGNORE = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.venv', 'venv', '.deploykit-state', 'coverage']);

function listFiles(root, dir, ignore) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks into the digest — avoids cycles and escaping root
    if (entry.isDirectory()) out = out.concat(listFiles(root, full, ignore));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** A deterministic content identity for a source tree: sorted relative paths, each paired
 * with its own sha256, folded into one canonical digest. Two trees with identical file
 * contents at identical paths always produce the same digest regardless of filesystem
 * traversal order, mtimes, or OS — this is the "source" half of the app tier's provenance
 * story (see docs/implementation-status.md's Remaining Tasks R3): pacmanager can verify
 * this byte-exactly on every build; it cannot verify the resulting container image is
 * reproducible, and does not claim to. */
export function treeDigest(root, { extraIgnore = [] } = {}) {
  const stat = statSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const ignore = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
  const files = listFiles(root, root, ignore).sort();
  if (!files.length) throw new Error(`No files found under ${root} (after excluding ${[...ignore].join(', ')})`);
  const digest = createHash('sha256');
  for (const rel of files) {
    const fileHash = createHash('sha256').update(readFileSync(join(root, ...rel.split('/')))).digest('hex');
    digest.update(rel).update('\0').update(fileHash).update('\n');
  }
  return { digest: digest.digest('hex'), fileCount: files.length, files };
}
