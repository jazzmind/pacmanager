import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digest } from '../src/contract.js';
import { authorize } from '../src/policy.js';
const a = JSON.parse(readFileSync(new URL('../examples/knowledge-hub/artifact.json', import.meta.url)));
const now = Date.parse('2026-01-01T00:00:00Z');
const request = { capability: 'knowledge', operation: 'search', binding: 'mock', user: 'alice' };
const grant = { id: 'g1', subject: a.metadata.name, digest: digest(a), ...request, revoked: false, expiresAt: '2026-01-02T00:00:00Z' };
test('PAC-003 explicit grants required even for mocks', () => {
  assert.equal(authorize(a, request, [], now).allowed, false);
  assert.equal(authorize(a, request, [grant], now).allowed, true);
});
test('PAC-003 isolate user, artifact, digest, operation and binding', () => {
  for (const patch of [{ user: 'bob' }, { subject: 'other' }, { digest: 'old' },
    { operation: 'write' }, { binding: 'live' }, { revoked: true }, { revoked: undefined },
    { expiresAt: '2025-01-01' }, { expiresAt: 'invalid' }, { id: '' }]) {
    assert.equal(authorize(a, request, [{ ...grant, ...patch }], now).allowed, false);
  }
  assert.equal(authorize(a, { ...request, binding: 'live' }, [grant], now).allowed, false);
  assert.equal(authorize(a, null, [], now).allowed, false);
});
test('PAC-003 manifest changes invalidate approval', () => {
  const revised = structuredClone(a); revised.metadata.version = '0.2.0';
  assert.equal(authorize(revised, request, [grant], now).allowed, false);
});
