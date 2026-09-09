import { readdirSync, readFileSync } from 'node:fs';
import { validate } from '../src/contract.js';
import assert from 'node:assert/strict';
for (const dir of readdirSync('examples')) {
 const a = JSON.parse(readFileSync('examples/' + dir + '/artifact.json'));
 assert.deepEqual(validate(a), []);
}
const tests = readdirSync('test').map(f => readFileSync('test/' + f, 'utf8')).join('\n');
for (const file of readdirSync('specs/core')) {
 const spec = readFileSync('specs/core/' + file, 'utf8');
 for (const part of ['<!--','## Acceptance Criteria','## Scenarios','**Steps:**','**Expected Results:**']) assert.ok(spec.includes(part), file + ': ' + part);
 for (const id of new Set(spec.match(/PAC-\d{3}/g))) assert.ok(tests.includes(id), 'Missing test reference ' + id);
}
console.log('Examples and spec references valid (not a feature-completeness audit).');

