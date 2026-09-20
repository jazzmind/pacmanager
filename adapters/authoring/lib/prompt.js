/**
 * Builds the chat messages sent to the model for a 'generate' request. One prompt shape
 * regardless of artifact kind — the model always returns a flat map of relative file paths to
 * full text content plus a chosen `kind`; lib/scaffold.js decides afterward whether that map
 * becomes an inline `source` (interactive/knowledge) or files written to `workdir`
 * (application). Keeping one shape here keeps lib/parse.js and this prompt from drifting apart
 * kind-by-kind.
 *
 * The safety constraints are stated up front from the *same* constants demo/definition.js's
 * gate enforces (passed through verbatim as payload.constraints by store.js) specifically so
 * the prompt and the gate can never disagree — see docs/implementation-status.md.
 */
const KIND_GUIDANCE = {
  interactive: 'An interactive web page or small game, rendered entirely client-side. No build step, no server, no network calls — everything must run standalone in a sandboxed iframe.',
  knowledge: 'A knowledge workspace / "digital expert" layout that presents recorded agent-run briefings. Must include the literal marker <!--PAC-BRIEFINGS--> in index.html at the point where briefings should render — the host substitutes real content there.',
  application: 'A real client+API application: a small but complete, runnable project (e.g. a Dockerfile, a server entrypoint, and whatever source files it needs). Not subject to the static tier\'s file-type/network restrictions — but must be genuinely runnable via `docker build` + the Dockerfile you provide.',
  auto: 'Not yet decided. Read the brief and choose the single best-fitting concrete kind — "interactive", "knowledge", or "application" — then generate for that kind. You must return that chosen kind (never "auto") and a one-to-two-sentence `rationale` explaining the choice.',
};

// The host (demo/definition.js's compileStatic) assembles the final document itself: every
// .css file's content is concatenated into ONE auto-generated <style> block, every .js file's
// content is concatenated into ONE auto-generated <script> block (wrapped in its own IIFE) at
// the end of <body>, and .json/.svg files become window.PAC_ASSETS[filename] (the raw file
// text — JSON.parse it yourself if you need an object). This is true ONLY for the static tier
// (interactive/knowledge) -- an "application"-kind project is a real, independently-run
// project with none of this. Told explicitly because a model's instinct is to hand-author
// <script>/<style> tags, which the safety gate rejects outright (a literal "</script" or
// "</style" anywhere in source is a hard failure, even inside index.html's own closing tag).
const STATIC_ASSEMBLY_NOTE = [
  'index.html is ONLY the visible body markup — a fragment, not a full document (no <html>, <head>, <body>, <script>, or <style> tags of your own; the host wraps it).',
  'ALL CSS goes in one or more .css files (e.g. styles.css) — the host concatenates them into the page\'s single <style> block for you.',
  'ALL JavaScript goes in one or more .js files (e.g. app.js) — the host concatenates them into the page\'s single <script> block (already wrapped in an IIFE with \'use strict\') for you. Do not write <script> tags anywhere.',
  'Any .json/.svg files you include are available at runtime as window.PAC_ASSETS["filename"] (the raw file text).',
].join('\n');

function constraintsBlock(kind, constraints = {}) {
  if (kind === 'application') return 'This is an "application"-kind artifact: no file-type or network restriction, but it must include a working Dockerfile at its root and actually run.';
  const { maxFiles, maxBytes, extensions, requiredFiles, forbidden = [], requireBriefingsMarker } = constraints;
  return [
    STATIC_ASSEMBLY_NOTE,
    '',
    `Hard constraints (violating ANY of these gets your output rejected and you will be asked to repair it):`,
    `- At most ${maxFiles ?? 25} files, totaling at most ${Math.round((maxBytes ?? 512000) / 1000)}KB.`,
    `- File extensions limited to: ${(extensions ?? ['.html', '.css', '.js', '.json', '.svg']).join(', ')}.`,
    `- Must include: ${(requiredFiles ?? ['index.html']).join(', ')}.`,
    `- No network access of any kind: no fetch(), XMLHttpRequest, WebSocket, navigator.sendBeacon, and no "http://" or "https://" reference anywhere (no CDN scripts, no external fonts, no external images) — everything must be inline or a local file you also provide.`,
    `- No eval(), no "new Function(...)", no dynamic import(), no document.write().`,
    `- Never write the literal character sequence "</script" or "</style" anywhere, including as a normal HTML tag (it breaks the generated document) — see the assembly note above for why you should never need to.`,
    forbidden.length ? `- Specifically forbidden patterns: ${forbidden.join(', ')}.` : '',
    requireBriefingsMarker ? `- Must include the literal text <!--PAC-BRIEFINGS--> in index.html.` : '',
  ].filter(Boolean).join('\n');
}

function previousAttemptBlock(previousAttempt) {
  if (!previousAttempt) return '';
  const files = previousAttempt.source ? Object.entries(previousAttempt.source).map(([p, t]) => `--- ${p} ---\n${t}`).join('\n\n') : '(no source captured)';
  return [
    '',
    'Your previous attempt was rejected. Fix EVERY issue below — do not repeat them, and do not just delete the offending code if it was load-bearing; find a compliant way to keep the feature.',
    'Rejected issues:',
    ...(previousAttempt.issues || []).map(i => '- ' + i),
    '',
    'Your previous attempt (for reference — repair it, do not start over unless truly necessary):',
    files,
  ].join('\n');
}

// Revise, not rewrite (see pacmanager's demo/store.js startGeneration): found live that every
// edit was a full re-roll, because nothing ever told the model an artifact already existed —
// it only ever saw a brief and generated from nothing. When the host has an existing source
// map and a specific changeRequest, show the model the real current files and ask for exactly
// that change, not a fresh interpretation of the (possibly stale, unchanged) brief.
function currentSourceBlock(currentSource, changeRequest) {
  if (!currentSource) return '';
  const files = Object.entries(currentSource).map(([p, t]) => `--- ${p} ---\n${t}`).join('\n\n');
  return [
    '',
    'THIS IS A REVISION OF AN EXISTING, ALREADY-WORKING ARTIFACT — not a new one. The brief above',
    'describes the artifact as a whole, for background; it is not new instructions to reinterpret.',
    'Your job is the single change below, nothing else.',
    '',
    `Requested change: ${changeRequest}`,
    '',
    'Rules for a revision:',
    '- Return the COMPLETE, final content of every file below, exactly as it should be after the change.',
    '- Everything not related to the requested change must come back byte-for-byte identical to how it is shown here — same structure, same features, same styling. Do not "clean up," refactor, or improve anything you were not asked to touch.',
    '- Do not start over or reinterpret the brief from scratch. This is a small, targeted edit to real, already-correct code.',
    '- You may add or remove a file only if the requested change genuinely requires it.',
    '',
    'Current source:',
    files,
  ].join('\n');
}

// What each server-reachable capability actually means for the code the model writes --
// matches pacmanager's demo/capabilities.js ids and pracman's runtime adapter conventions
// (adapters/runtime/deploykit/lib/appspec.js), so a business user's picker choice becomes a
// concrete, correct instruction rather than the model guessing at env var names.
const CAPABILITY_CODE_GUIDANCE = {
  'shared-data': 'A real Postgres database is available at the connection string in the DATABASE_URL environment variable. Connect to it directly; do not invent your own storage.',
  documents: 'A real Postgres database with the pgvector extension already enabled is available at DATABASE_URL. The extension exists, but retrieval code (embedding, storing, and querying vectors) does not -- you must write it.',
  'ai-models': 'An OpenAI-compatible chat completions gateway is available at LITELLM_URL, authenticated with the LITELLM_API_KEY environment variable as a bearer token. Call it directly for any AI features; do not call a different provider.',
};
function capabilitiesBlock(capabilities) {
  if (!capabilities?.length) return '';
  const guided = capabilities.filter(id => CAPABILITY_CODE_GUIDANCE[id]);
  if (!guided.length) return '';
  return ['', 'This application was scoped with the following real capabilities -- write code that actually uses them:', ...guided.map(id => `- ${CAPABILITY_CODE_GUIDANCE[id]}`)].join('\n');
}

export function buildMessages(payload) {
  const { kind, title, brief, accent, attempt, maxAttempts, constraints, previousAttempt, currentSource, changeRequest, capabilities } = payload;
  const isRevise = Boolean(currentSource);
  const system = [
    'You are the authoring engine inside PAC Manager, a self-service internal app platform.',
    isRevise
      ? 'A user is asking for a specific change to an artifact you already built. Make exactly that change to the real, existing source below — do not regenerate it from the brief as if it were new.'
      : 'A user submitted a brief describing something they want built. You generate the real, working source for it — never a placeholder, never a template with the title pasted in.',
    'Respond with ONLY this exact plain-text format (no markdown fences, no JSON, no prose before or after) -- each file\'s content is copied VERBATIM, with no escaping of any kind, so write it exactly as it should appear in the real file, including real newlines:',
    '',
    '@@PAC_KIND: interactive|knowledge|application@@',
    '@@PAC_RATIONALE: one sentence -- ONLY include this line if the requested kind was "auto"@@',
    '@@PAC_FILE: index.html@@',
    '<the complete, literal, final content of this file -- nothing omitted, nothing abbreviated>',
    '@@PAC_FILE: styles.css@@',
    '<the complete, literal, final content of this file>',
    '@@PAC_END@@',
    '',
    'Rules: one @@PAC_FILE: <path>@@ line per file, each followed immediately by that file\'s raw content (no code fences around it, no extra indentation). End with a line that is exactly @@PAC_END@@. Never write the literal text "@@PAC_FILE:" or "@@PAC_END@@" inside a file\'s own content.',
  ].join('\n');
  const user = [
    `Artifact kind: ${kind} — ${KIND_GUIDANCE[kind] || KIND_GUIDANCE.auto}`,
    `Title: ${title}`,
    `Brief: ${brief}`,
    accent ? `Visual accent (a CSS color token name, purely cosmetic — do not fetch a real palette for it, just pick sensible colors): ${accent}` : '',
    '',
    constraintsBlock(kind, constraints),
    capabilitiesBlock(capabilities),
    attempt > 1 ? `\nThis is attempt ${attempt} of ${maxAttempts}.` : '',
    currentSourceBlock(currentSource, changeRequest),
    previousAttemptBlock(previousAttempt),
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
