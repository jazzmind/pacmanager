/**
 * Issues a scoped, budgeted LiteLLM virtual key per app, instead of handing every generated app
 * the shared LiteLLM master key. Today, `DEPLOYKIT_LITELLM_KEY` *is* the master key (see
 * `deploykit/sandbox/scripts/bootstrap-sandbox.sh`'s `DEPLOYKIT_LITELLM_KEY=${LITELLM_MASTER_KEY}`)
 * — every app declaring the `ai-models` capability gets full admin access to the proxy: no
 * budget, no rate limit, and the ability to call LiteLLM's own key-management API. This module
 * closes that gap using LiteLLM's real `/key/generate`/`/key/delete` management endpoints.
 *
 * Ports the pattern from `localllm/busibox/srv/agent/app/api/coding_agents.py` +
 * `app/services/litellm_client.py` — see pracman/docs/gap-analysis.md §2.6, "do not rebuild
 * these" — restricted to this workspace's capability aliases (see
 * deploykit/sandbox/litellm/config.yaml) instead of busibox's own purpose names.
 *
 * Delete-then-generate, not find-and-reuse. Verified live against the running proxy: `/key/list`
 * (even alias-filtered) returns only a key's hashed identifier, never its raw secret value —
 * LiteLLM shows a raw key exactly once, at generation, by design. Busibox's own `CodingAgentKey`
 * model reflects the same constraint (it indexes which aliases exist for display, not to recover
 * a usable value) — busibox just never tries to silently re-mint on redeploy the way this module
 * needs to. Since a redeploy already rewrites the whole container's env unconditionally, deleting
 * any previous key for this app's alias and minting a fresh one is safe (the old key stops being
 * useful the same moment the container's env changes anyway) and avoids "alias already exists"
 * (a real 400 hit live during testing) without needing a local cache of raw key values.
 */

// Coding-generation apps only ever need chat/agent-shaped capability aliases, not every model
// in the proxy's catalog (a scoped key naming vendor models directly would defeat the whole
// point of routing through capability names in the first place — see the model-mapping work).
export const DEFAULT_ALLOWED_MODELS = ['chat', 'agent', 'fast', 'frontier', 'embed', 'authoring'];

export function keyAliasFor(appId) {
  return `pac-app-${appId}`;
}

/** Best-effort delete by alias. A 404 ("no keys found") means there was nothing to replace --
 * that's the expected, common case for a brand-new app, not a failure. */
async function deleteByAlias(litellmUrl, masterKey, alias, fetchImpl) {
  const res = await fetchImpl(`${litellmUrl}/key/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${masterKey}` },
    body: JSON.stringify({ key_aliases: [alias] }),
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  const text = await res.text().catch(() => '');
  throw new Error(`litellm /key/delete ${res.status}: ${text.slice(0, 300)}`);
}

/**
 * Returns `{ key, alias, replaced }`. `key` is the raw LiteLLM virtual key value, suitable for
 * injecting as `LITELLM_API_KEY`. `replaced` is true when a prior key for this app's alias
 * existed and was deleted first.
 */
export async function ensureAppKey(appId, {
  litellmUrl, masterKey, maxBudget, budgetDuration = '30d', rpmLimit, tpmLimit,
  allowedModels = DEFAULT_ALLOWED_MODELS, fetchImpl = fetch,
} = {}) {
  if (!appId) throw new Error('ensureAppKey requires appId');
  if (!litellmUrl || !masterKey) throw new Error('ensureAppKey requires litellmUrl and masterKey');
  const alias = keyAliasFor(appId);

  const replaced = await deleteByAlias(litellmUrl, masterKey, alias, fetchImpl);

  const body = {
    key_alias: alias,
    models: allowedModels,
    metadata: { pac_app_id: appId, purpose: 'pac-app-runtime' },
  };
  if (maxBudget != null) { body.max_budget = maxBudget; body.budget_duration = budgetDuration; }
  if (rpmLimit != null) body.rpm_limit = rpmLimit;
  if (tpmLimit != null) body.tpm_limit = tpmLimit;

  const res = await fetchImpl(`${litellmUrl}/key/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${masterKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`litellm /key/generate ${res.status}: ${data.error?.message || data.detail || text.slice(0, 300)}`);
  if (!data.key) throw new Error('litellm /key/generate returned no key value');
  return { key: data.key, alias, replaced };
}

/** Best-effort revoke on undeploy -- mirrors this adapter's existing posture elsewhere
 * (deprovisionDb/deprovisionStore in deploykit are independently try/excepted so one failure
 * doesn't skip the other); a key that fails to delete is a cost/cleanup issue, never a reason
 * to fail the undeploy itself. */
export async function revokeAppKey(appId, { litellmUrl, masterKey, fetchImpl = fetch } = {}) {
  if (!litellmUrl || !masterKey) return { deleted: false, reason: 'not_configured' };
  const alias = keyAliasFor(appId);
  try {
    const deleted = await deleteByAlias(litellmUrl, masterKey, alias, fetchImpl);
    return { deleted };
  } catch (error) {
    return { deleted: false, reason: error.message };
  }
}
