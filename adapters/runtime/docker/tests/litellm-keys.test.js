import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAppKey, revokeAppKey, keyAliasFor, DEFAULT_ALLOWED_MODELS } from '../lib/litellm-keys.js';

function fakeFetchSequence(handlers) {
  let i = 0;
  return async (url, opts) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return handler(String(url), opts);
  };
}

test('KEYS-001 keyAliasFor is deterministic per app id', () => {
  assert.equal(keyAliasFor('my-app'), 'pac-app-my-app');
  assert.equal(keyAliasFor('my-app'), keyAliasFor('my-app'));
});

test('KEYS-002 mints a scoped key for a brand-new app (a 404 on the preceding delete means nothing to replace)', async () => {
  const calls = [];
  const fetchImpl = fakeFetchSequence([
    async url => { calls.push(url); return new Response(JSON.stringify({ error: { message: 'No keys found' } }), { status: 404 }); }, // /key/delete
    async (url, opts) => {
      calls.push(url);
      const body = JSON.parse(opts.body);
      assert.equal(body.key_alias, 'pac-app-my-app');
      assert.deepEqual(body.models, DEFAULT_ALLOWED_MODELS);
      assert.equal(body.metadata.pac_app_id, 'my-app');
      return new Response(JSON.stringify({ key: 'sk-scoped-abc123' }), { status: 200 });
    },
  ]);
  const result = await ensureAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl });
  assert.equal(result.key, 'sk-scoped-abc123');
  assert.equal(result.alias, 'pac-app-my-app');
  assert.equal(result.replaced, false);
  assert.match(calls[0], /\/key\/delete$/);
  assert.match(calls[1], /\/key\/generate$/);
});

test('KEYS-003 a redeploy deletes the app\'s previous key first, then mints a fresh one -- verified live: /key/list never returns a reusable raw value, so this is the only correct idempotency strategy', async () => {
  const fetchImpl = fakeFetchSequence([
    async () => new Response(JSON.stringify({ deleted_keys: ['pac-app-my-app'] }), { status: 200 }), // /key/delete succeeds -- one existed
    async () => new Response(JSON.stringify({ key: 'sk-fresh-456' }), { status: 200 }),
  ]);
  const result = await ensureAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl });
  assert.equal(result.key, 'sk-fresh-456');
  assert.equal(result.replaced, true);
});

test('KEYS-004 surfaces a specific error when the preceding delete fails for a reason other than "not found"', async () => {
  const fetchImpl = fakeFetchSequence([
    async () => new Response('Internal Server Error', { status: 500 }),
  ]);
  await assert.rejects(
    () => ensureAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl }),
    /litellm \/key\/delete 500/,
  );
});

test('KEYS-005 passes max_budget/rpm_limit/tpm_limit through to /key/generate when provided', async () => {
  const fetchImpl = fakeFetchSequence([
    async () => new Response(JSON.stringify({ error: { message: 'No keys found' } }), { status: 404 }),
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.max_budget, 5.5);
      assert.equal(body.budget_duration, '30d');
      assert.equal(body.rpm_limit, 60);
      assert.equal(body.tpm_limit, 100000);
      return new Response(JSON.stringify({ key: 'sk-budgeted' }), { status: 200 });
    },
  ]);
  const result = await ensureAppKey('my-app', {
    litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl,
    maxBudget: 5.5, rpmLimit: 60, tpmLimit: 100000,
  });
  assert.equal(result.key, 'sk-budgeted');
});

test('KEYS-006 surfaces a specific error when /key/generate itself fails', async () => {
  const fetchImpl = fakeFetchSequence([
    async () => new Response(JSON.stringify({ error: { message: 'No keys found' } }), { status: 404 }),
    async () => new Response(JSON.stringify({ error: { message: 'budget exceeded' } }), { status: 400 }),
  ]);
  await assert.rejects(
    () => ensureAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl }),
    /litellm \/key\/generate 400: budget exceeded/,
  );
});

test('KEYS-007 requires appId, litellmUrl and masterKey', async () => {
  await assert.rejects(() => ensureAppKey(undefined, { litellmUrl: 'x', masterKey: 'y' }), /requires appId/);
  await assert.rejects(() => ensureAppKey('app', { masterKey: 'y' }), /requires litellmUrl and masterKey/);
  await assert.rejects(() => ensureAppKey('app', { litellmUrl: 'x' }), /requires litellmUrl and masterKey/);
});

test('KEYS-008 revokeAppKey deletes by alias and never throws on failure (best-effort, matches undeploy\'s existing posture)', async () => {
  const calls = [];
  const okFetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return new Response(JSON.stringify({ deleted_keys: ['pac-app-my-app'] }), { status: 200 }); };
  const result = await revokeAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl: okFetch });
  assert.equal(result.deleted, true);
  assert.deepEqual(calls[0][1], { key_aliases: ['pac-app-my-app'] });

  const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };
  const failResult = await revokeAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl: throwingFetch });
  assert.equal(failResult.deleted, false);
  assert.equal(failResult.reason, 'ECONNREFUSED');
});

test('KEYS-009 revokeAppKey treats "nothing to delete" (404) as a clean, non-error outcome', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'No keys found' } }), { status: 404 });
  const result = await revokeAppKey('my-app', { litellmUrl: 'http://litellm:4000', masterKey: 'sk-master', fetchImpl });
  assert.equal(result.deleted, false);
  assert.equal(result.reason, undefined);
});

test('KEYS-010 revokeAppKey is a no-op when litellm is not configured, rather than throwing', async () => {
  const result = await revokeAppKey('my-app', {});
  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'not_configured');
});
