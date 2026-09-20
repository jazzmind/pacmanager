import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../lib/scaffold.js';

test('SCAFFOLD-001 interactive/knowledge kinds pass through as inline source, untouched', () => {
  const out = scaffold({ kind: 'interactive', files: { 'index.html': '<h1>hi</h1>' } }, null);
  assert.deepEqual(out, { source: { 'index.html': '<h1>hi</h1>' } });
});

test('SCAFFOLD-002 application kind writes real files under workdir and returns sourcePath', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pac-scaffold-'));
  try {
    const out = scaffold({ kind: 'application', files: { 'Dockerfile': 'FROM node:22-alpine', 'src/index.js': 'console.log("hi")' } }, workdir);
    assert.equal(out.sourcePath, workdir);
    assert.equal(readFileSync(join(workdir, 'Dockerfile'), 'utf8'), 'FROM node:22-alpine');
    assert.equal(readFileSync(join(workdir, 'src/index.js'), 'utf8'), 'console.log("hi")');
  } finally { rmSync(workdir, { recursive: true, force: true }); }
});

test('SCAFFOLD-003 application kind without a workdir is a clear error, not a silent no-op', () => {
  assert.throws(() => scaffold({ kind: 'application', files: { Dockerfile: 'FROM scratch' } }, null), /requires a workdir/);
});

test('SCAFFOLD-004 application kind missing a Dockerfile is rejected before pacmanager ever sees it', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pac-scaffold-'));
  try {
    assert.throws(() => scaffold({ kind: 'application', files: { 'index.js': 'x' } }, workdir), /requires a Dockerfile/);
    assert.equal(existsSync(join(workdir, 'index.js')), true); // the file itself is still written -- only the Dockerfile check fails
  } finally { rmSync(workdir, { recursive: true, force: true }); }
});

test('SCAFFOLD-005 rejects a path that escapes the workdir (e.g. "../") before ever writing anything', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pac-scaffold-'));
  try {
    assert.throws(() => scaffold({ kind: 'application', files: { '../escape.txt': 'x', 'Dockerfile': 'FROM scratch' } }, workdir), /Unsafe file path/);
    assert.equal(existsSync(join(workdir, '..', 'escape.txt')), false);
  } finally { rmSync(workdir, { recursive: true, force: true }); }
});
