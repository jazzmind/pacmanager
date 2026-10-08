import test from 'node:test';
import assert from 'node:assert/strict';
import { toAppSpec } from '../lib/appspec.js';

test('APPSPEC-001 maps a static-tier payload to a valid AppSpec with a local_path', () => {
  const spec = toAppSpec({ id: 'arcade-demo-a1b2c3', displayName: 'Arcade Demo', port: 4100, pathPrefix: '/arcade-demo', healthEndpoint: '/health', syncCapable: true }, { localPath: 'arcade-demo-a1b2c3' });
  assert.equal(spec.id, 'arcade-demo-a1b2c3');
  assert.equal(spec.name, 'Arcade Demo');
  assert.equal(spec.local_path, 'arcade-demo-a1b2c3');
  assert.equal(spec.port, 4100);
  assert.equal(spec.path_prefix, '/arcade-demo');
  assert.equal(spec.sync_capable, true);
  assert.equal(spec.memory_limit, '512m');
  assert.equal(spec.cpu_limit, '0.5');
});

test('APPSPEC-002 falls back to id as the display name, and to /{id} as the path prefix', () => {
  const spec = toAppSpec({ id: 'plain-app' }, { localPath: 'plain-app' });
  assert.equal(spec.name, 'plain-app');
  assert.equal(spec.path_prefix, '/plain-app');
  assert.equal(spec.port, 3000);
  assert.equal(spec.health_endpoint, '/health');
});

test('APPSPEC-003 requires a stable id and rejects a non-slug value', () => {
  assert.throws(() => toAppSpec({}, { localPath: 'x' }), /requires payload.id/);
  assert.throws(() => toAppSpec({ id: 'Not A Slug' }, { localPath: 'x' }), /valid slug/);
  assert.throws(() => toAppSpec({ id: '1-starts-with-digit' }, { localPath: 'x' }), /valid slug/);
});

test('APPSPEC-004 requires exactly one source: image, repoUrl, or a materialized localPath', () => {
  assert.throws(() => toAppSpec({ id: 'x' }, {}), /exactly one of image, repoUrl/);
  const withImage = toAppSpec({ id: 'x', image: 'nginx:latest' }, {});
  assert.equal(withImage.image, 'nginx:latest');
  assert.equal(withImage.local_path, undefined);
});

test('APPSPEC-005 repo_url deploys carry the branch, and dockerfile/build/start commands pass through', () => {
  const spec = toAppSpec({ id: 'x', repoUrl: 'https://github.com/org/repo', repoBranch: 'feature/x', dockerfile: 'docker/Dockerfile', buildCommand: 'npm ci', startCommand: 'npm start' }, {});
  assert.equal(spec.repo_url, 'https://github.com/org/repo');
  assert.equal(spec.repo_branch, 'feature/x');
  assert.equal(spec.dockerfile, 'docker/Dockerfile');
  assert.equal(spec.build_command, 'npm ci');
  assert.equal(spec.start_command, 'npm start');
});

test('APPSPEC-006 envRefs become deploykit provisioning sentinels; explicit envVars for the same key win', () => {
  const spec = toAppSpec({ id: 'x', image: 'y', envRefs: { DATABASE_URL: 'postgres', DDB_ENDPOINT: 'objects' }, envVars: { DATABASE_URL: 'postgres://explicit', NODE_ENV: 'production' } }, {});
  assert.equal(spec.env_vars.DATABASE_URL, 'postgres://explicit');
  assert.equal(spec.env_vars.DDB_ENDPOINT, '{{DK_DDB_ENDPOINT}}');
  assert.equal(spec.env_vars.NODE_ENV, 'production');
});

test('APPSPEC-007 an unknown resource type in envRefs fails closed rather than silently omitting it', () => {
  assert.throws(() => toAppSpec({ id: 'x', image: 'y', envRefs: { SOME_VAR: 'unknown-type' } }, {}), /Unknown resource type/);
});

test('APPSPEC-008 a pgvector envRef maps to the same sentinel as postgres -- the extension itself is enabled separately by cli.js before deploy, not by this mapping', () => {
  const spec = toAppSpec({ id: 'x', image: 'y', envRefs: { DATABASE_URL: 'pgvector' } }, {});
  assert.equal(spec.env_vars.DATABASE_URL, '{{DK_DB_URL}}');
});

test('APPSPEC-009 a litellm envRef injects the declared var plus the fixed LITELLM_URL/LITELLM_API_KEY convention, sourced from this adapter\'s own env -- fails closed if unconfigured', () => {
  const keys = ['PAC_LITELLM_URL', 'PAC_LITELLM_KEY', 'DEPLOYKIT_LITELLM_URL', 'DEPLOYKIT_LITELLM_KEY'];
  const restore = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.throws(() => toAppSpec({ id: 'x', image: 'y', envRefs: { OPENAI_BASE_URL: 'litellm' } }, {}), /neither PAC_LITELLM_URL nor DEPLOYKIT_LITELLM_URL is configured/);
    process.env.DEPLOYKIT_LITELLM_URL = 'http://litellm:4000'; process.env.DEPLOYKIT_LITELLM_KEY = 'sk-test';
    const spec = toAppSpec({ id: 'x', image: 'y', envRefs: { OPENAI_BASE_URL: 'litellm' } }, {});
    assert.equal(spec.env_vars.OPENAI_BASE_URL, 'http://litellm:4000');
    assert.equal(spec.env_vars.LITELLM_URL, 'http://litellm:4000');
    assert.equal(spec.env_vars.LITELLM_API_KEY, 'sk-test');
  } finally {
    for (const k of keys) { if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k]; }
  }
});

test('APPSPEC-010 PAC_LITELLM_URL/PAC_LITELLM_KEY is the canonical name and takes priority over the deprecated DEPLOYKIT_LITELLM_* fallback', () => {
  const keys = ['PAC_LITELLM_URL', 'PAC_LITELLM_KEY', 'DEPLOYKIT_LITELLM_URL', 'DEPLOYKIT_LITELLM_KEY'];
  const restore = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.PAC_LITELLM_URL = 'http://pac-canonical:4000'; process.env.PAC_LITELLM_KEY = 'sk-pac';
    process.env.DEPLOYKIT_LITELLM_URL = 'http://deprecated:4000'; process.env.DEPLOYKIT_LITELLM_KEY = 'sk-deprecated';
    const spec = toAppSpec({ id: 'x', image: 'y', envRefs: { OPENAI_BASE_URL: 'litellm' } }, {});
    assert.equal(spec.env_vars.LITELLM_URL, 'http://pac-canonical:4000');
    assert.equal(spec.env_vars.LITELLM_API_KEY, 'sk-pac');
  } finally {
    for (const k of keys) { if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k]; }
  }
});

test('APPSPEC-011 a temporal envRef injects the declared var plus a fixed TEMPORAL_ADDRESS convention, sourced from this adapter\'s own env -- previously this threw "Unknown resource type"', () => {
  const restore = process.env.PAC_TEMPORAL_ADDRESS;
  try {
    delete process.env.PAC_TEMPORAL_ADDRESS;
    const defaulted = toAppSpec({ id: 'x', image: 'y', envRefs: { TEMPORAL_ADDRESS: 'temporal' } }, {});
    assert.equal(defaulted.env_vars.TEMPORAL_ADDRESS, 'temporal:7233');

    process.env.PAC_TEMPORAL_ADDRESS = 'temporal.internal:9999';
    const spec = toAppSpec({ id: 'x', image: 'y', envRefs: { MY_TEMPORAL_VAR: 'temporal' } }, {});
    assert.equal(spec.env_vars.MY_TEMPORAL_VAR, 'temporal.internal:9999');
    assert.equal(spec.env_vars.TEMPORAL_ADDRESS, 'temporal.internal:9999');
  } finally {
    if (restore === undefined) delete process.env.PAC_TEMPORAL_ADDRESS; else process.env.PAC_TEMPORAL_ADDRESS = restore;
  }
});

test('APPSPEC-PFX-1 PAC_APP_PATH_PREFIX mounts apps at /pac-<id> (default /<id>) and tells the app via APP_BASE_PATH', () => {
  const keep = process.env.PAC_APP_PATH_PREFIX;
  try {
    delete process.env.PAC_APP_PATH_PREFIX;
    let spec = toAppSpec({ id: 'my-app', image: 'x' }, {});
    assert.equal(spec.path_prefix, '/my-app'); assert.equal(spec.env_vars.APP_BASE_PATH, '/my-app');
    process.env.PAC_APP_PATH_PREFIX = '/pac-';
    spec = toAppSpec({ id: 'my-app', image: 'x' }, {});
    assert.equal(spec.path_prefix, '/pac-my-app'); assert.equal(spec.env_vars.APP_BASE_PATH, '/pac-my-app');
    // an explicit pathPrefix or APP_BASE_PATH still wins
    spec = toAppSpec({ id: 'my-app', image: 'x', pathPrefix: '/custom', envVars: { APP_BASE_PATH: '/mine' } }, {});
    assert.equal(spec.path_prefix, '/custom'); assert.equal(spec.env_vars.APP_BASE_PATH, '/mine');
    process.env.PAC_APP_PATH_PREFIX = 'nope';
    assert.throws(() => toAppSpec({ id: 'my-app', image: 'x' }, {}), /PAC_APP_PATH_PREFIX/);
  } finally { if (keep === undefined) delete process.env.PAC_APP_PATH_PREFIX; else process.env.PAC_APP_PATH_PREFIX = keep; }
});
