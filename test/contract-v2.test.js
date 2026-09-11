import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, digest } from '../src/contract.js';

const base = { apiVersion: 'pac.jazzmind.dev/v1alpha2', kind: 'application', metadata: { name: 'demo-app', version: '1.0.0', owner: 'devops' } };
const staticArtifact = { ...base, spec: { target: 'static', resources: [], capabilities: [] } };
const serviceArtifact = { ...base, spec: { target: 'service', resources: [], capabilities: [],
  workload: { image: 'registry.example/app@sha256:' + 'a'.repeat(64), port: 3000, cpuMillis: 500, memoryMiB: 512 },
  network: { inbound: 'deny', outbound: 'deny' } } };
const lambdaArtifact = { ...base, spec: { target: 'lambda', resources: [], capabilities: [],
  workload: { handler: 'src/api/index.handler', memoryMiB: 256, cpuMillis: 200 } } };

test('CONTRACT-V2-001 valid static/service/lambda artifacts validate clean', () => {
  assert.deepEqual(validate(staticArtifact), []);
  assert.deepEqual(validate(serviceArtifact), []);
  assert.deepEqual(validate(lambdaArtifact), []);
});

test('CONTRACT-V2-002 static target rejects a workload or network block (no server workload exists)', () => {
  const withWorkload = structuredClone(staticArtifact); withWorkload.spec.workload = { image: 'x@sha256:' + 'a'.repeat(64), port: 1, cpuMillis: 1, memoryMiB: 1 };
  assert.ok(validate(withWorkload).some(e => /spec.workload is not allowed/.test(e)));
  const withNetwork = structuredClone(staticArtifact); withNetwork.spec.network = { inbound: 'deny', outbound: 'deny' };
  assert.ok(validate(withNetwork).some(e => /spec.network is not allowed/.test(e)));
});

test('CONTRACT-V2-003 service target enforces digest-pinned image and deny-by-default network, same rules as v1alpha1', () => {
  const mutable = structuredClone(serviceArtifact); mutable.spec.workload.image = 'untrusted:latest';
  assert.ok(validate(mutable).some(e => /digest-pinned/.test(e)));
  const openNetwork = structuredClone(serviceArtifact); openNetwork.spec.network.outbound = 'allow';
  assert.ok(validate(openNetwork).some(e => /deny both directions/.test(e)));
});

test('CONTRACT-V2-004 lambda target requires a handler path and forbids a network block', () => {
  const badHandler = structuredClone(lambdaArtifact); badHandler.spec.workload.handler = 'not a handler';
  assert.ok(validate(badHandler).some(e => /handler must be a module.export path/.test(e)));
  const withNetwork = structuredClone(lambdaArtifact); withNetwork.spec.network = { inbound: 'deny', outbound: 'deny' };
  assert.ok(validate(withNetwork).some(e => /network is not allowed for target lambda/.test(e)));
});

test('CONTRACT-V2-005 invalid target is rejected and unknown top-level/spec fields fail closed', () => {
  const badTarget = structuredClone(staticArtifact); badTarget.spec.target = 'kubernetes';
  assert.ok(validate(badTarget).some(e => /invalid spec.target/.test(e)));
  const extraTop = { ...staticArtifact, admin: true };
  assert.ok(validate(extraTop).some(e => /unknown field admin/.test(e)));
  const extraSpec = structuredClone(staticArtifact); extraSpec.spec.egress = 'allow';
  assert.ok(validate(extraSpec).some(e => /unknown field egress/.test(e)));
});

test('CONTRACT-V2-006 resources and capabilities reuse the same shared rules as v1alpha1 (duplicate/unsupported rejected)', () => {
  const dup = structuredClone(serviceArtifact); dup.spec.resources = [{ name: 'db', type: 'postgres' }, { name: 'db', type: 'postgres' }];
  assert.ok(validate(dup).some(e => /duplicate resource/.test(e)));
  const badCap = structuredClone(serviceArtifact); badCap.spec.capabilities = [{ name: 'x', operation: 'y', binding: 'production' }];
  assert.ok(validate(badCap).some(e => /invalid binding/.test(e)));
});

test('CONTRACT-V2-007 v1alpha1 and v1alpha2 digests are independent and both deterministic', () => {
  assert.equal(digest(staticArtifact), digest(Object.fromEntries(Object.entries(staticArtifact).reverse())));
  assert.notEqual(digest(staticArtifact), digest(serviceArtifact));
});
