/** Callers pass capability ALIASES (chat, agent, fast, authoring, frontier), never vendor model
 * names -- the alias->model mapping lives in LiteLLM's config, so it can change without touching pacmanager.
 * One real chat-completion call through the configured LiteLLM proxy. Factored out of
 * admin.js's LLM test console so the per-app chat/plan feature (demo/chat.js) can reuse the
 * exact same call instead of duplicating it -- both are "send a real prompt, get real text
 * back," just with different system prompts and different callers. */
/** A hung gateway must not hold a request (or a UI spinner) open forever: every call carries a deadline, combined with the caller's own signal (client disconnect, Stop). */
const withTimeout = (signal, env) => { const t = AbortSignal.timeout(Number(env.PAC_CHAT_TIMEOUT_MS) || 120000); return signal ? AbortSignal.any([signal, t]) : t; };
const wrapAbort = e => { throw e?.name === 'TimeoutError' ? Object.assign(new Error('The model took too long to respond (timed out).'), { status: 502 }) : e?.name === 'AbortError' ? Object.assign(new Error('Request cancelled'), { status: 499, aborted: true }) : e; };
export async function completeChat({ model, messages, maxTokens, signal } = {}, env = process.env) {
  if (!env.PAC_LITELLM_URL) throw Object.assign(new Error('No LLM configured. Set PAC_LITELLM_URL (and PAC_LITELLM_KEY if required).'), { status: 501 });
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages is required'), { status: 400 });
  const started = Date.now();
  const res = await fetch(new URL('/v1/chat/completions', env.PAC_LITELLM_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.PAC_LITELLM_KEY ? { Authorization: `Bearer ${env.PAC_LITELLM_KEY}` } : {}) },
    body: JSON.stringify({ model: model || env.PAC_LITELLM_DEFAULT_MODEL || 'chat', messages, max_tokens: Number(maxTokens) || 1024 }),
    signal: withTimeout(signal, env),
  }).catch(wrapAbort);
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

/** Streaming variant: same request shape with stream:true, parsing the upstream SSE body. onDelta gets visible text only; reasoning_content and empty
 * deltas are ignored but still count as liveness (the deadline is an idle timeout here -- re-armed on every upstream chunk -- since a thinking model can
 * legitimately stream for a long time). Resolves with the full text once the upstream finishes. */
export async function streamChat({ model, messages, maxTokens, signal } = {}, onDelta, env = process.env) {
  if (!env.PAC_LITELLM_URL) throw Object.assign(new Error('No LLM configured. Set PAC_LITELLM_URL (and PAC_LITELLM_KEY if required).'), { status: 501 });
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages is required'), { status: 400 });
  const idleMs = Number(env.PAC_CHAT_TIMEOUT_MS) || 120000, idle = new AbortController();
  let timer; const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('idle', 'TimeoutError')), idleMs); };
  const sig = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  arm();
  try {
    const res = await fetch(new URL('/v1/chat/completions', env.PAC_LITELLM_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.PAC_LITELLM_KEY ? { Authorization: `Bearer ${env.PAC_LITELLM_KEY}` } : {}) },
      body: JSON.stringify({ model: model || env.PAC_LITELLM_DEFAULT_MODEL || 'chat', messages, max_tokens: Number(maxTokens) || 1024, stream: true }),
      signal: sig,
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw Object.assign(new Error(data.error?.message || `LLM call failed (HTTP ${res.status})`), { status: 502 }); }
    let content = '', finishReason = null, usedModel = model, buf = '';
    const handle = line => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let evt; try { evt = JSON.parse(data); } catch { return; }
      if (evt.error) throw Object.assign(new Error(evt.error.message || 'LLM stream failed'), { status: 502 });
      usedModel = evt.model || usedModel;
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text) { content += text; onDelta?.(text); }
    };
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      arm();
      buf += decoder.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    }
    handle(buf.trim());
    return { content, finishReason, model: usedModel };
  } catch (e) { if (e?.status) throw e; wrapAbort(e); }
  finally { clearTimeout(timer); }
}
