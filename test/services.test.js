import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveGraduationResources } from '../demo/services.js';

// A minimal fake shaped like loadCatalog()'s return value -- only .service(kind) is needed
// by deriveGraduationResources, so the fake only implements that.
function fakeCatalog(entries) {
  const byKind = new Map(Object.entries(entries));
  return { service: kind => byKind.get(kind) };
}

test('SERVICES-RES-001 derives a deterministic resource reference per bound kind, grouped by prod.resourceType', () => {
  const catalog = fakeCatalog({
    pgvector: { prod: { resourceType: 'db' } },
    litellm: { prod: { resourceType: 'secret' } },
  });
  const resources = deriveGraduationResources({ DATABASE_URL: 'pgvector', LITELLM_URL: 'litellm' }, catalog, 'my-app');
  assert.deepEqual(resources, { db: ['my-app-pgvector'], secret: ['my-app-litellm'] });
});

test('SERVICES-RES-002 skips kinds with no prod.resourceType (local-only bindings, e.g. mock-api)', () => {
  const catalog = fakeCatalog({
    'mock-api': { prod: { resourceType: null } },
    pgvector: { prod: { resourceType: 'db' } },
  });
  const resources = deriveGraduationResources({ MOCK_URL: 'mock-api', DATABASE_URL: 'pgvector' }, catalog, 'my-app');
  assert.deepEqual(resources, { db: ['my-app-pgvector'] });
});

test('SERVICES-RES-003 two envRefs naming the same kind collapse to one reference, not two', () => {
  const catalog = fakeCatalog({ pgvector: { prod: { resourceType: 'db' } } });
  const resources = deriveGraduationResources({ DATABASE_URL: 'pgvector', SEARCH_DB_URL: 'pgvector' }, catalog, 'my-app');
  assert.deepEqual(resources, { db: ['my-app-pgvector'] });
});

test('SERVICES-RES-004 two different kinds sharing the same prod.resourceType both land under it', () => {
  const catalog = fakeCatalog({
    litellm: { prod: { resourceType: 'secret' } },
    redis: { prod: { resourceType: 'secret' } },
  });
  const resources = deriveGraduationResources({ LITELLM_URL: 'litellm', REDIS_URL: 'redis' }, catalog, 'my-app');
  assert.deepEqual(resources, { secret: ['my-app-litellm', 'my-app-redis'] });
});

test('SERVICES-RES-005 an unknown kind (not in the catalog at all) is skipped rather than throwing', () => {
  const catalog = fakeCatalog({ pgvector: { prod: { resourceType: 'db' } } });
  const resources = deriveGraduationResources({ DATABASE_URL: 'pgvector', X: 'not-a-real-kind' }, catalog, 'my-app');
  assert.deepEqual(resources, { db: ['my-app-pgvector'] });
});

test('SERVICES-RES-006 no envRefs at all produces an empty resources map', () => {
  const catalog = fakeCatalog({});
  assert.deepEqual(deriveGraduationResources(undefined, catalog, 'my-app'), {});
  assert.deepEqual(deriveGraduationResources({}, catalog, 'my-app'), {});
});
