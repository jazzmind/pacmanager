import { completeChat } from './litellm.js';
import { CAPABILITIES, SENSITIVE_DATA_NOTICE, expandCapabilities, deriveKind, deriveEnvRefs } from './capabilities.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** The system prompt is built from the same capability list the picker and definition.js use, so the model can only propose what the backend will accept. */
function systemPrompt() {
  const line = c => `- ${c.id} (${c.label}): ${c.description}`;
  const usable = CAPABILITIES.filter(c => c.group !== 'future'), future = CAPABILITIES.filter(c => c.group === 'future');
  return [
    'You are the intake assistant for an internal app studio. A business user describes what they want; you propose a minimal, honest application draft.',
    '',
    'Capabilities you may select (use the ids exactly):',
    ...usable.map(c => line({ ...c, label: `${c.label}; group: ${c.group}${c.implies ? '; also needs ' + c.implies.join(', ') : ''}` })),
    '',
    'UNAVAILABLE capabilities (never select; if the user needs one, list it under "unavailable" with why):',
    ...future.map(line),
    '',
    SENSITIVE_DATA_NOTICE,
    '',
    'Rules: prefer the MINIMAL set of capabilities. Prefer static / no-server (the "works today" group) unless the app truly needs a shared database or AI at runtime. Ask at most 3 clarifying questions, and only if essential; otherwise return an empty questions array.',
    'Reply with ONLY a single JSON object, no prose, no code fence, with exactly these keys:',
    '{"title": string (3-80 chars), "summary": string (<=500 chars, what the app is), "capabilities": [{"id": string, "why": string}], "unavailable": [{"id": string, "why": string}], "kindRationale": string (why this kind of app: interactive page, knowledge briefing page, or server application), "plan": string (markdown: what will be built, screens, data, which capabilities and why, open questions), "questions": [string]}',
  ].join('\n');
}

/** Tolerant extraction: strips ```json fences and surrounding prose by taking the outermost {...}. Throws with a message fit to feed back to the model. */
export function parseDraftJson(text) {
  const t = String(text || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found in the reply');
  const value = JSON.parse(body.slice(start, end + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reply was not a JSON object');
  return value;
}

const reasons = list => (Array.isArray(list) ? list : []).filter(x => x && typeof x === 'object' && typeof x.id === 'string')
  .map(x => ({ id: x.id.trim(), why: typeof x.why === 'string' ? x.why.trim().slice(0, 500) : '' }));

/** Server-side normalisation: the model proposes, the server decides -- unknown ids dropped, "future" ids moved to unavailable, implied capabilities added
 * (flagged), kind and envRefs derived from capabilities rather than trusted from the model. */
export function normaliseDraft(raw) {
  const unavailable = reasons(raw.unavailable).filter(u => CAPABILITIES.some(c => c.id === u.id));
  const picked = [];
  for (const c of reasons(raw.capabilities)) {
    const cap = CAPABILITIES.find(x => x.id === c.id);
    if (!cap) continue;
    if (cap.group === 'future') { if (!unavailable.some(u => u.id === c.id)) unavailable.push(c); continue; }
    if (!picked.some(x => x.id === c.id)) picked.push(c);
  }
  const ids = picked.map(c => c.id), expanded = expandCapabilities(ids);
  const capabilities = [...picked, ...expanded.filter(id => !ids.includes(id)).map(id => ({ id, why: `Required by ${picked.filter(c => CAPABILITIES.find(x => x.id === c.id)?.implies?.includes(id)).map(c => c.id).join(', ') || 'another selected capability'}.`, implied: true }))];
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let title = str(raw.title, 80); if (title.length < 3) title = (title + ' App').trim().padEnd(3, '.');
  return {
    title, summary: str(raw.summary, 500), capabilities, unavailable,
    kind: deriveKind(expanded), kindRationale: str(raw.kindRationale, 1000), plan: str(raw.plan, 20000),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 500)).slice(0, 3),
    envRefs: deriveEnvRefs(expanded),
  };
}

/** AI-led "new application": brief (+ optional clarifying history) in, a reviewable draft out. Nothing is created -- the user confirms in the UI, which then POSTs /api/apps. */
export async function draftApplication({ brief, history } = {}, env = process.env) {
  if (typeof brief !== 'string' || brief.trim().length < 10 || brief.length > 3000) fail(400, 'brief must be 10–3000 characters');
  if (history !== undefined && (!Array.isArray(history) || history.length > 10 || history.some(h => !h || !['user', 'assistant'].includes(h.role) || typeof h.content !== 'string' || !h.content.trim() || h.content.length > 3000))) fail(400, 'history must be at most 10 {role: user|assistant, content} entries');
  const messages = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: brief.trim() }, ...(history || []).map(h => ({ role: h.role, content: h.content }))];
  const model = env.PAC_DRAFT_MODEL || 'agent';
  let reply = await completeChat({ model, messages, maxTokens: 3000 }, env), error;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!reply.content && reply.finishReason === 'length') fail(502, 'The model ran out of budget before it finished the draft. Try a shorter brief.');
    try { return normaliseDraft(parseDraftJson(reply.content)); } catch (e) { error = e; }
    if (attempt === 0) reply = await completeChat({ model, messages: [...messages, { role: 'assistant', content: reply.content || '(empty)' }, { role: 'user', content: `Your reply could not be parsed: ${error.message}. Reply again with ONLY the JSON object described above.` }], maxTokens: 3000 }, env);
  }
  fail(502, `The model did not return a usable draft (${error.message}). Try again or rephrase the brief.`);
}
