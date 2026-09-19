import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, CAPABILITY_IDS, USE_CASES, deriveKind, expandCapabilities, deriveEnvRefs } from '../demo/capabilities.js';

test('CAP-001 every capability referenced by a use case is a real, known id', () => {
  for (const useCase of USE_CASES) for (const id of useCase.capabilities) assert.ok(CAPABILITY_IDS.includes(id), `${useCase.id} references unknown capability ${id}`);
});

test('CAP-002 every "implies" target is itself a real, known id (no dangling dependency)', () => {
  for (const cap of CAPABILITIES) for (const dep of cap.implies || []) assert.ok(CAPABILITY_IDS.includes(dep), `${cap.id} implies unknown capability ${dep}`);
});

test('CAP-003 deriveKind: any server-group capability forces "application", regardless of what else is selected', () => {
  assert.equal(deriveKind(['analyze', 'shared-data']), 'application');
  assert.equal(deriveKind(['ai-models']), 'application');
});

test('CAP-004 deriveKind: "briefings" alone (no server capability) maps to "knowledge"', () => {
  assert.equal(deriveKind(['briefings', 'collaborate']), 'knowledge');
});

test('CAP-005 deriveKind: anything else defaults to "interactive"', () => {
  assert.equal(deriveKind([]), 'interactive');
  assert.equal(deriveKind(['analyze', 'export-data']), 'interactive');
});

test('CAP-006 expandCapabilities pulls in implied dependencies transitively and de-duplicates', () => {
  assert.deepEqual(expandCapabilities(['documents']).sort(), ['documents', 'shared-data']);
  assert.deepEqual(expandCapabilities(['documents', 'shared-data']).sort(), ['documents', 'shared-data']);
});

test('CAP-007 deriveEnvRefs maps server capabilities onto real deploykit-facing env var names, skipping capabilities with no envRef', () => {
  const envRefs = deriveEnvRefs(['ai-models', 'collaborate']);
  assert.deepEqual(envRefs, { LITELLM_URL: 'litellm' });
});

test('CAP-008 deriveEnvRefs on "documents" (pgvector) does not also emit a separate postgres entry despite implying shared-data -- same DATABASE_URL key, pgvector wins', () => {
  const envRefs = deriveEnvRefs(['documents']);
  assert.deepEqual(envRefs, { DATABASE_URL: 'pgvector' });
});

test('CAP-009 the "not available yet" group never carries an envRef or feeds a use case toward deriveKind\'s server branch', () => {
  const future = CAPABILITIES.filter(c => c.group === 'future');
  assert.ok(future.length > 0);
  for (const cap of future) assert.equal(cap.envRef, undefined);
});
