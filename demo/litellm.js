/** Callers pass capability ALIASES (chat, agent, fast, authoring, frontier), never vendor model
 * names -- the alias->model mapping lives in LiteLLM's config, so it can change without touching pacmanager.
 * One real chat-completion call through the configured LiteLLM proxy. Factored out of
 * admin.js's LLM test console so the per-app chat/plan feature (demo/chat.js) can reuse the
 * exact same call instead of duplicating it -- both are "send a real prompt, get real text
 * back," just with different system prompts and different callers. */
export async function completeChat({ model, messages, maxTokens } = {}, env = process.env) {
  if (!env.PAC_LITELLM_URL) throw Object.assign(new Error('No LLM configured. Set PAC_LITELLM_URL (and PAC_LITELLM_KEY if required).'), { status: 501 });
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages is required'), { status: 400 });
  const started = Date.now();
  const res = await fetch(new URL('/v1/chat/completions', env.PAC_LITELLM_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.PAC_LITELLM_KEY ? { Authorization: `Bearer ${env.PAC_LITELLM_KEY}` } : {}) },
    body: JSON.stringify({ model: model || env.PAC_LITELLM_DEFAULT_MODEL || 'chat', messages, max_tokens: Number(maxTokens) || 1024 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || `LLM call failed (HTTP ${res.status})`), { status: 502 });
  return {
    model: data.model || model,
    content: data.choices?.[0]?.message?.content || '',
    finishReason: data.choices?.[0]?.finish_reason || null,
    usage: data.usage || null,
    costUsd: Number(res.headers.get('x-litellm-response-cost')) || null,
    tookMs: Date.now() - started,
  };
}
