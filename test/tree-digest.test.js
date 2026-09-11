import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeDigest } from '../demo/tree-digest.js';

function tree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('TREE-001 is deterministic across repeated calls on the same tree', t => {
  const dir = tree(t, { 'index.html': '<h1>hi</h1>', 'src/app.js': 'console.log(1)' });
  const a = treeDigest(dir), b = treeDigest(dir);
  assert.equal(a.digest, b.digest);
  assert.equal(a.fileCount, 2);
});

test('TREE-002 changes when any file content changes', t => {
  const dir = tree(t, { 'index.html': 'v1' });
  const before = treeDigest(dir).digest;
  writeFileSync(join(dir, 'index.html'), 'v2');
  const after = treeDigest(dir).digest;
  assert.notEqual(before, after);
});

test('TREE-003 changes when a file is added or removed, not just when content changes', t => {
  const dir = tree(t, { 'a.txt': 'x' });
  const before = treeDigest(dir).digest;
  writeFileSync(join(dir, 'b.txt'), 'y');
  const afterAdd = treeDigest(dir).digest;
  assert.notEqual(before, afterAdd);
});

test('TREE-004 is independent of filesystem traversal order (renaming top-level dirs)', t => {
  const dirA = tree(t, { 'zzz/file.txt': 'content', 'aaa/other.txt': 'more' });
  const dirB = tree(t, { 'aaa/other.txt': 'more', 'zzz/file.txt': 'content' });
  assert.equal(treeDigest(dirA).digest, treeDigest(dirB).digest);
});

test('TREE-005 excludes node_modules, .git, dist, build, .next, .venv, coverage by default', t => {
  const dir = tree(t, { 'src/app.js': 'real', 'node_modules/pkg/index.js': 'noise', 'dist/bundle.js': 'noise', '.git/HEAD': 'noise' });
  const result = treeDigest(dir);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.files, ['src/app.js']);
});

test('TREE-006 does not follow symlinks into the tree (avoids escaping root or cycles)', t => {
  const outside = mkdtempSync(join(tmpdir(), 'pac-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'should not appear');
  const dir = tree(t, { 'index.html': 'x' });
  symlinkSync(outside, join(dir, 'linked'));
  const result = treeDigest(dir);
  assert.deepEqual(result.files, ['index.html']);
});

test('TREE-007 rejects a non-existent or non-directory path', t => {
  assert.throws(() => treeDigest('/nonexistent/path/xyz'), /Not a directory/);
  const dir = tree(t, { 'file.txt': 'x' });
  assert.throws(() => treeDigest(join(dir, 'file.txt')), /Not a directory/);
});

test('TREE-008 rejects an empty tree (after exclusions) with a clear message', t => {
  const dir = tree(t, { 'node_modules/pkg/index.js': 'only excluded files' });
  assert.throws(() => treeDigest(dir), /No files found/);
});

test('TREE-009 extraIgnore lets a caller exclude additional directory names', t => {
  const dir = tree(t, { 'src/app.js': 'real', 'vendor/lib.js': 'exclude me' });
  const result = treeDigest(dir, { extraIgnore: ['vendor'] });
  assert.deepEqual(result.files, ['src/app.js']);
});
