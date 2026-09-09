import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
for (const command of ['validate','plan','export']) test(`CLI ${command}`, () => {
  const r = spawnSync(process.execPath, ['src/cli.js', command, 'examples/knowledge-hub/artifact.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.ok(JSON.parse(r.stdout));
});
test('CLI fails missing command and missing file', () => {
  for (const args of [[], ['plan','absent.json'], ['publish','examples/knowledge-hub/artifact.json']]) {
    assert.equal(spawnSync(process.execPath, ['src/cli.js', ...args]).status, 1);
  }
});
