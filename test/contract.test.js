import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, digest } from '../src/contract.js';
import { plan, graduation } from '../src/planner.js';
const fixture = () => JSON.parse(readFileSync(new URL('../examples/knowledge-hub/artifact.json', import.meta.url)));

test('PAC-001 valid contract and deterministic digest', () => {
  const a = fixture(); assert.deepEqual(validate(a), []);
  assert.equal(digest(a), digest(Object.fromEntries(Object.entries(a).reverse())));
});
test('PAC-001 unknown fields, malformed values and duplicate resources rejected', () => {
  for (const mutation of [a => a.admin = true, a => a.network.egress = 'allow',
    a => a.metadata.name = '../escape', a => a.workload.image = 'untrusted:latest',
    a => a.resources.push(a.resources[0]), a => a.workload.cpuMillis = 3000,
    a => a.resources = null, a => a.capabilities = [null], a => a.kind = 'root']) {
    const a = fixture(); mutation(a); assert.ok(validate(a).length);
  }
  assert.ok(validate(null).length);
});
test('PAC-002 plans have no implicit network grants or runtime claims', () => {
  const p = plan(fixture()); assert.equal(p.mode, 'plan-only');
  assert.deepEqual(p.network.ingress, []); assert.deepEqual(p.network.egress, []);
  assert.ok(p.blockers.length); assert.equal(p.workload.privileged, false);
});
test('PAC-004 graduation preserves contract and discloses missing evidence', () => {
  const a = fixture(), out = graduation(a);
  assert.deepEqual(out.artifact, a); assert.equal(out.readiness, 'incomplete');
  assert.equal(out.score.containers.app.image, a.workload.image);
  assert.ok(out.requiredEvidence.includes('restore-test'));
});
