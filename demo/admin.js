import { connect } from 'node:net';
import { assuranceRecord, completeness } from './assurance.js';

const OWNER_PRINCIPAL = { kind: 'owner', label: 'Admin console' };

/** Cross-app aggregation for the admin console's overview panel — fans out the per-app
 * assuranceRecord()/completeness() calls that already exist rather than adding new Store
 * methods, and merges every app's audit[] into one feed sorted newest-first. Owner-only
 * caller (enforced by server.js's requireAdmin before this is ever reached), so store.list
 * is called with a synthetic owner principal to see every app including shared/archived ones. */
export function adminOverview(store) {
  const summaries = store.list(OWNER_PRINCIPAL, { includeArchived: true });
  const apps = summaries.map(summary => {
    const app = store.state.apps.find(a => a.id === summary.id);
    let record = null, complete = null;
    try { record = assuranceRecord(app); complete = completeness(record); } catch { /* no release yet, or malformed assurance -- overview degrades, doesn't fail */ }
    return { ...summary, completeness: complete, auditCount: (app.audit || []).length };
  });
  const audit = store.state.apps
    .flatMap(a => (a.audit || []).map(entry => ({ appId: a.id, title: a.config?.title || '(untitled)', ...entry })))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 50);
  return {
    apps,
    audit,
    totals: {
      apps: summaries.length,
      archived: summaries.filter(a => a.archivedAt).length,
      published: summaries.filter(a => a.published).length,
      deployed: summaries.filter(a => a.lastDeployment).length,
    },
  };
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

async function probeHttp(url, path, { headers = {}, ok = res => res.ok } = {}) {
  if (!url) return { status: 'absent', detail: 'not configured' };
  try {
    const res = await withTimeout(fetch(new URL(path, url), { headers }), 4000);
    return ok(res) ? { status: 'up', detail: `HTTP ${res.status}` } : { status: 'down', detail: `HTTP ${res.status}` };
  } catch (error) {
    return { status: 'down', detail: error.message };
  }
}

/** No Temporal client here on purpose -- a raw TCP connect proves the port is reachable
 * without pacmanager itself taking a Temporal SDK dependency; a genuine namespace-level
 * check happens through the orchestration adapter below, when one is configured. */
function probeTcp(address) {
  if (!address) return Promise.resolve({ status: 'absent', detail: 'not configured' });
  const [host, portStr] = address.split(':');
  const port = Number(portStr);
  return withTimeout(new Promise((resolve, reject) => {
    const socket = connect(port, host);
    socket.once('connect', () => { socket.destroy(); resolve({ status: 'up', detail: `${address} reachable` }); });
    socket.once('error', err => reject(err));
  }), 3000).catch(error => ({ status: 'down', detail: error.message }));
}

/** Every tile always appears, even when its adapter/env var is unset -- an "absent" service
 * is information (see the plan's admin-console section: a missing service should render
 * `absent`, not vanish, mirroring deploykit's own fixed-expected-service-list pattern). */
export async function adminServices({ runtime, orchestration, env = process.env } = {}) {
  const [litellm, ollama, deploykit, temporal] = await Promise.all([
    probeHttp(env.PAC_LITELLM_URL, '/health/liveliness'),
    probeHttp(env.PAC_OLLAMA_URL, '/api/tags'),
    runtime ? runtime.health().then(r => ({ status: r.output?.healthy === false ? 'down' : 'up', detail: JSON.stringify(r.output || {}).slice(0, 200) })).catch(e => ({ status: 'down', detail: e.message })) : Promise.resolve({ status: 'absent', detail: 'PAC_RUNTIME_ADAPTER not configured' }),
    orchestration
      ? orchestration.health().then(r => ({ status: r.status === 'ok' ? 'up' : 'down', detail: JSON.stringify(r.output || r.message || {}).slice(0, 200) })).catch(e => ({ status: 'down', detail: e.message }))
      : probeTcp(env.PAC_TEMPORAL_ADDRESS),
  ]);
  return {
    services: [
      { id: 'litellm', name: 'LiteLLM proxy', ...litellm },
      { id: 'ollama', name: 'Ollama', ...ollama },
      { id: 'deploykit', name: 'DeployKit runtime', ...deploykit },
      { id: 'temporal', name: 'Temporal', ...temporal },
    ],
  };
}

/** Real completion through litellm's OpenAI-compatible endpoint -- net-new: nothing else in
 * pacmanager sends a prompt directly. max_tokens defaults generously; local-qwen (an
 * extended-thinking-style local model) returns empty content with finish_reason:"length" on
 * a too-small budget, a trap already hit and documented elsewhere in this workspace. */
export async function adminLlmTest({ model, prompt, maxTokens }, env = process.env) {
  if (!env.PAC_LITELLM_URL) throw Object.assign(new Error('No LLM configured. Set PAC_LITELLM_URL (and PAC_LITELLM_KEY if required).'), { status: 501 });
  if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('prompt is required'), { status: 400 });
  const started = Date.now();
  const res = await fetch(new URL('/v1/chat/completions', env.PAC_LITELLM_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.PAC_LITELLM_KEY ? { Authorization: `Bearer ${env.PAC_LITELLM_KEY}` } : {}) },
    body: JSON.stringify({ model: model || env.PAC_LITELLM_DEFAULT_MODEL || 'local-qwen', messages: [{ role: 'user', content: prompt }], max_tokens: Number(maxTokens) || 1024 }),
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

export async function adminOrchestrationTest({ orchestration }) {
  if (!orchestration) throw Object.assign(new Error('No orchestration adapter configured. Set PAC_ORCHESTRATION_ADAPTER.'), { status: 501 });
  const health = await orchestration.health();
  if (health.status !== 'ok') throw Object.assign(new Error(health.message || 'Orchestration health check failed'), { status: 502 });
  const listed = await orchestration.listWorkflows({ pageSize: 10 }).catch(e => ({ status: 'error', message: e.message }));
  return { health: health.output, recentWorkflows: listed.status === 'ok' ? listed.output?.workflows || [] : [], listError: listed.status === 'error' ? listed.message : null };
}

export async function adminAgentTest({ agent, prompt }) {
  if (!agent) throw Object.assign(new Error('No agent adapter configured. Set PAC_AGENT_ADAPTER.'), { status: 501 });
  if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('prompt is required'), { status: 400 });
  const result = await agent.run({ prompt });
  if (result.status !== 'ok') throw Object.assign(new Error(result.message || 'Agent run failed'), { status: 502 });
  return result.output;
}
