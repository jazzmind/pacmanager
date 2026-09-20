import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeLocal } from '../lib/materialize.js';

function tempWorkdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-materialize-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('MATERIALIZE-001 writes an inline static-tier source map to workdir/<id>', t => {
  const workdir = tempWorkdir(t);
  const result = materializeLocal('demo-app', { source: { 'index.html': '<h1>hi</h1>', 'style.css': 'body{color:red}' } }, workdir);
  assert.equal(result, 'demo-app');
  assert.equal(readFileSync(join(workdir, 'demo-app', 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.equal(readFileSync(join(workdir, 'demo-app', 'style.css'), 'utf8'), 'body{color:red}');
});

test('MATERIALIZE-001b synthesizes a Dockerfile and nginx conf alongside the source map, so deploykit\'s `docker build` has something to build', t => {
  const workdir = tempWorkdir(t);
  materializeLocal('demo-app', { source: { 'index.html': '<h1>hi</h1>' } }, workdir);
  const dockerfile = readFileSync(join(workdir, 'demo-app', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM nginx:alpine/);
  assert.match(dockerfile, /COPY \. \/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /COPY pac-nginx\.conf/);
  assert.match(dockerfile, /EXPOSE 3000/);
  const conf = readFileSync(join(workdir, 'demo-app', 'pac-nginx.conf'), 'utf8');
  assert.match(conf, /location \/health/);
  assert.match(conf, /listen 3000/);
  // the app's own inline source is untouched by the synthesized infra
  assert.equal(readFileSync(join(workdir, 'demo-app', 'index.html'), 'utf8'), '<h1>hi</h1>');
});

test('MATERIALIZE-002 re-materializing replaces stale files rather than merging with a prior deploy', t => {
  const workdir = tempWorkdir(t);
  materializeLocal('demo-app', { source: { 'a.html': '1', 'old.html': 'stale' } }, workdir);
  materializeLocal('demo-app', { source: { 'a.html': '2' } }, workdir);
  assert.equal(readFileSync(join(workdir, 'demo-app', 'a.html'), 'utf8'), '2');
  assert.equal(existsSync(join(workdir, 'demo-app', 'old.html')), false, 'a file dropped from the new release must not survive from the old one');
});

test('MATERIALIZE-003 rejects a path-traversal or absolute path in the source map', t => {
  const workdir = tempWorkdir(t);
  assert.throws(() => materializeLocal('demo-app', { source: { '../escape.html': 'x' } }, workdir), /Unsafe source path/);
  assert.throws(() => materializeLocal('demo-app', { source: { '/etc/passwd': 'x' } }, workdir), /Unsafe source path/);
});

test('MATERIALIZE-004 an app-tier sourcePath is symlinked, not copied, so edits are picked up live', t => {
  const workdir = tempWorkdir(t);
  const real = mkdtempSync(join(tmpdir(), 'pac-real-app-'));
  t.after(() => rmSync(real, { recursive: true, force: true }));
  writeFileSync(join(real, 'index.html'), 'v1');
  materializeLocal('real-app', { sourcePath: real }, workdir);
  const linkPath = join(workdir, 'real-app');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
  assert.equal(realpathSync(linkPath), realpathSync(real));
  writeFileSync(join(real, 'index.html'), 'v2');
  assert.equal(readFileSync(join(linkPath, 'index.html'), 'utf8'), 'v2', 'a live edit in the real folder must be visible through the symlink with no re-materialization');
});

test('MATERIALIZE-005 rejects a sourcePath that does not exist', t => {
  const workdir = tempWorkdir(t);
  assert.throws(() => materializeLocal('demo-app', { sourcePath: join(workdir, 'nope') }, workdir), /does not exist/);
});

test('MATERIALIZE-006 an image/repo deploy needs no materialization and returns null', t => {
  const workdir = tempWorkdir(t);
  assert.equal(materializeLocal('demo-app', { image: 'nginx:latest' }, workdir), null);
});
