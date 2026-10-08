/**
 * Chat-completion provider for the authoring adapter: the sandbox LiteLLM proxy first,
 * falling back to a direct Anthropic or OpenAI API key when LiteLLM is unreachable or
 * misconfigured. Per explicit product direction: "make sure our local litellm works and has
 * the API key. We also have anthropic keys and openai keys in .env files ... we can use with
 * litellm as fallbacks locally."
 *
 * Env vars: PAC_LITELLM_URL/PAC_LITELLM_KEY is the canonical name (matches pacmanager's own
 * admin console) — DEPLOYKIT_LITELLM_URL/DEPLOYKIT_LITELLM_KEY is accepted as a deprecated
 * fallback for one release, since deploykit's webui/lib/embeddings.ts and
 * sandbox/src/deploykit/litellm_client.py both still read that name. Corrected 2026-09-20:
 * previously this was the *only* name, which is exactly the two-different-names-for-one-proxy
 * misconfiguration risk pracman/docs/architecture.md's "Redundancies" section calls out.
 *
 * Deliberately thin: one shape in (a system + user message pair), one shape out (the model's
 * raw text and which model/route actually answered). Response *parsing* (JSON extraction,
 * validation) is lib/parse.js's job, not this module's — this module only knows how to get
 * text back from a model, and how to fail with a message specific enough for pacmanager's
 * authoringStatus() to classify (see its credential_missing/gateway_unreachable regex).
 */
// A chat-completion message's content is normally a plain string, but some gateway/model
// combinations return an array of content blocks instead (or, when truncated mid-thinking,
// something else entirely) -- tolerate both rather than assuming the common case.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : b?.text || '')).join('');
  return '';
}

export function createProvider(env = process.env, fetchImpl = fetch) {
  const litellmUrl = (env.PAC_LITELLM_URL || env.DEPLOYKIT_LITELLM_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const litellmKey = env.PAC_LITELLM_KEY || env.DEPLOYKIT_LITELLM_KEY || env.LITELLM_MASTER_KEY || '';
  const litellmModel = env.PAC_AUTHORING_MODEL || 'authoring';
  // A caller naming a `local-*` alias (see deploykit/sandbox/litellm/config.yaml) is asking for
  // the no-egress guarantee specifically -- silently falling back to a direct cloud vendor call
  // on any litellm failure would defeat that guarantee without telling anyone. Per
  // pracman/docs/gap-analysis.md §5 decision 4 ("must fail, not silently fall back"), a
  // local-pinned request skips the direct-vendor fallbacks entirely and surfaces the real error.
  const isLocalPinned = litellmModel.startsWith('local-');
  const anthropicKey = isLocalPinned ? '' : (env.ANTHROPIC_API_KEY || '');
  const anthropicModel = env.PAC_AUTHORING_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
  const openaiKey = isLocalPinned ? '' : (env.OPENAI_API_KEY || '');
  const openaiModel = env.PAC_AUTHORING_OPENAI_MODEL || 'gpt-4.1';
  const timeoutMs = Number(env.PAC_AUTHORING_PROVIDER_TIMEOUT_MS || 150000);

  const THINKING_FORMS = [{ type: 'disabled' }, { type: 'between_tools' }, null];
  let thinkingIdx = 0, sendTemperature = true;
  async function callLiteLLM(messages) {
    if (!litellmKey) throw new Error('litellm_not_configured: no PAC_LITELLM_KEY (nor DEPLOYKIT_LITELLM_KEY or LITELLM_MASTER_KEY) set');
    // Which way to switch thinking off differs by model: older ones take {type:'disabled'}; Claude 5.5 rejects
    // that with a 400 telling you to send {type:'between_tools'}; some take neither. Try the known forms in
    // order, advancing only on a 400 that is about `thinking`; likewise `temperature` is dropped when a model
    // says it's deprecated. What worked is remembered for this adapter.
    let res, text, data;
    for (let tries = 0; tries < 6; tries++) {
      const i = thinkingIdx;
      res = await fetchImpl(litellmUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + litellmKey },
        // Found live: claude-sonnet-5 through this gateway defaults to extended thinking ON, and with a normal-length
        // authoring prompt the *entire* max_tokens budget can go to thinking, leaving message.content structurally
        // empty with finish_reason "length" -- not an error status, just silently no answer. Thinking buys nothing
        // for code generation against an already-fully-specified prompt, so turn it off rather than enlarge the budget.
        body: JSON.stringify({ model: litellmModel, messages, max_tokens: 16000, ...(sendTemperature ? { temperature: 0.4 } : {}), ...(THINKING_FORMS[i] ? { thinking: THINKING_FORMS[i] } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (res.status === 400 && /temperature/i.test(text) && sendTemperature) { sendTemperature = false; continue; } // newer Claude models deprecate it
      if (res.status === 400 && /thinking/i.test(text) && i + 1 < THINKING_FORMS.length) { thinkingIdx = i + 1; continue; }
      break;
    }
    if (!res.ok) throw new Error(`litellm ${res.status}: ${data.error?.message || data.detail || text.slice(0, 300)}`);
    const content = extractText(data.choices?.[0]?.message?.content);
    if (!content) {
      const reason = data.choices?.[0]?.finish_reason;
      throw new Error(reason === 'length' ? 'litellm truncated the response before producing any answer content (max_tokens exhausted)' : 'litellm returned no completion content');
    }
    return { text: content, route: 'litellm', model: litellmModel };
  }

  async function callAnthropic(messages) {
    if (!anthropicKey) throw new Error('anthropic_not_configured: no ANTHROPIC_API_KEY set');
    const system = messages.find(m => m.role === 'system')?.content;
    const rest = messages.filter(m => m.role !== 'system');
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: anthropicModel, system, messages: rest, max_tokens: 16000 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${data.error?.message || text.slice(0, 300)}`);
    const content = data.content?.map(b => b.text || '').join('') || '';
    if (!content) throw new Error('anthropic returned no completion content');
    return { text: content, route: 'anthropic-direct', model: anthropicModel };
  }

  async function callOpenAI(messages) {
    if (!openaiKey) throw new Error('openai_not_configured: no OPENAI_API_KEY set');
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + openaiKey },
      body: JSON.stringify({ model: openaiModel, messages, temperature: 0.4, max_tokens: 16000 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`openai ${res.status}: ${data.error?.message || text.slice(0, 300)}`);
    const content = extractText(data.choices?.[0]?.message?.content);
    if (!content) throw new Error('openai returned no completion content');
    return { text: content, route: 'openai-direct', model: openaiModel };
  }

  return {
    mode: `litellm(${litellmUrl}, model=${litellmModel}) + direct fallback (anthropic:${anthropicKey ? 'on' : 'off'}, openai:${openaiKey ? 'on' : 'off'}${isLocalPinned ? ', disabled: local-pinned model' : ''})`,
    /** Try litellm first; on ANY failure (network, 401, 5xx, empty response), fall back to
     * whichever direct keys are configured, in order. Reports the litellm failure specifically
     * when nothing else is configured either, since that's the state an operator most needs to
     * fix (per the product decision to hard-fail loudly and specifically, not vaguely). */
    async complete(messages) {
      let primaryError;
      try { return await callLiteLLM(messages); }
      catch (error) { primaryError = error; }
      if (anthropicKey) { try { return await callAnthropic(messages); } catch { /* keep trying */ } }
      if (openaiKey) { try { return await callOpenAI(messages); } catch { /* fall through to the original error below */ } }
      throw primaryError;
    },
    /** Cheap reachability probe for authoringStatus() — a real (tiny) completion, not just a
     * models list, so a correctly-shaped-but-invalid credential is caught the same way a real
     * generation would catch it. */
    async probe() {
      const reply = await this.complete([{ role: 'user', content: 'Reply with exactly: ok' }]);
      return { model: reply.model, route: reply.route };
    },
  };
}
