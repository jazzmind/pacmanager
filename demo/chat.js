import { completeChat } from './litellm.js';

/** What the model is honestly told about the app it's discussing -- never invented, never the
 * full source dump (that would blow the token budget and isn't needed for either mode below). */
function appContext(app) {
  const lines = [
    `Title: ${app.config.title}`,
    `Brief: ${app.config.brief}`,
    `Kind: ${app.config.kind || app.config.template || 'template'}`,
    `Tier: ${app.config.tier}`,
  ];
  if (app.config.capabilities?.length) lines.push(`Capabilities: ${app.config.capabilities.join(', ')}`);
  if (app.config.tier === 'static' && app.config.source) lines.push(`Files: ${Object.keys(app.config.source).join(', ')}`);
  lines.push(app.release ? `Published release: v${app.release.number}` : 'Not published yet.');
  return lines.join('\n');
}

/** Two modes, two different jobs for the model -- this is the fix for "every chat message
 * silently became a change request": Chat answers questions about the app as it actually is
 * and is explicitly told it cannot make changes; Plan drafts a plain-language description of
 * a requested change for the user to review/amend before anything is executed (execution is a
 * separate, explicit step -- see the "Execute this plan" action card in ui.js -- not part of
 * this call at all). Neither mode ever writes code or touches the app's real definition. */
export async function appChat(app, { mode, message }, env = process.env) {
  if (!['chat', 'plan'].includes(mode)) throw Object.assign(new Error('mode must be "chat" or "plan"'), { status: 400 });
  if (typeof message !== 'string' || !message.trim() || message.length > 3000) throw Object.assign(new Error('message must be 1–3000 characters'), { status: 400 });
  const context = appContext(app);
  const system = mode === 'plan'
    ? `You help plan changes to an existing application called "${app.config.title}". Given the app's real context below and the change the user is asking for, draft a short, concrete PLAN describing what will change and why, in plain language -- no code. The user will review and can amend this plan before anything is actually built; you are not writing or executing the change yourself.\n\n${context}`
    : `You answer questions about an existing application called "${app.config.title}" for the person using it. Be concise and honest, and state only things that are actually true about this app based on the context below. You cannot make changes to it -- if asked to change something, say so plainly and suggest switching to the Plan tab instead.\n\n${context}`;
  // Budgeted generously on purpose: local-qwen (an extended-thinking-style local model) burns
  // a large, variable amount of its token budget on internal reasoning before ever emitting
  // visible output, and returns EMPTY content with finish_reason:"length" if the budget runs
  // out first -- found live, confirmed at 800 (empty) vs 3000 (a real answer) for the same
  // prompt. Documented elsewhere in this workspace as the same trap; this is the concrete
  // number that actually clears it for a short plan/answer.
  const result = await completeChat({ messages: [{ role: 'system', content: system }, { role: 'user', content: message.trim() }], maxTokens: 3000 }, env);
  if (!result.content && result.finishReason === 'length') throw Object.assign(new Error('The model ran out of budget before it finished answering. Try a shorter or more specific question.'), { status: 502 });
  return { reply: result.content, mode };
}
