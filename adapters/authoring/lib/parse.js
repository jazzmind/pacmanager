/**
 * Extracts {kind, rationale?, files} from a model's raw text reply.
 *
 * Originally this asked the model for a single JSON object with file content as escaped
 * string values. Found live: with a real prompt (not a toy one), claude-sonnet-5 reliably --
 * not occasionally -- embedded literal, unescaped newlines inside JSON string values when
 * writing multi-line HTML/CSS/JS, which JSON.parse correctly rejects ("bad control character
 * in string literal"). This happened on 3 out of 3 attempts in the same generation request,
 * so it isn't noise the repair loop can average away -- asking a model to hand-escape
 * multi-line source code into a JSON string is just an unreliable format for this to begin
 * with, independent of prompt wording.
 *
 * Fix: don't ask for JSON. Ask for a plain delimited text format where file content is
 * copied verbatim, with no escaping step to get wrong:
 *
 *   @@PAC_KIND: interactive@@
 *   @@PAC_RATIONALE: one sentence, only when the requested kind was "auto"@@
 *   @@PAC_FILE: index.html@@
 *   <the complete, literal content of index.html>
 *   @@PAC_FILE: app.js@@
 *   <the complete, literal content of app.js>
 *   @@PAC_END@@
 *
 * A model can still wrap this in a stray ```-fence or add prose around it despite being told
 * not to (tolerated below, same as before) -- but once inside, there is nothing for it to
 * escape, so there is no equivalent failure mode.
 */
const FILE_MARKER = /^@@PAC_FILE:\s*(.+?)\s*@@$/;
const KIND_MARKER = /^@@PAC_KIND:\s*(.+?)\s*@@$/;
const RATIONALE_MARKER = /^@@PAC_RATIONALE:\s*(.+?)\s*@@$/;
const END_MARKER = /^@@PAC_END@@$/;

export function parseGenerationReply(text) {
  const lines = stripFence(String(text)).split('\n');
  let kind, rationale, currentPath = null, currentLines = null;
  const files = {};
  const flush = () => { if (currentPath !== null) files[currentPath] = currentLines.join('\n'); };
  for (const line of lines) {
    const fileMatch = line.match(FILE_MARKER);
    const kindMatch = currentPath === null ? line.match(KIND_MARKER) : null;
    const rationaleMatch = currentPath === null ? line.match(RATIONALE_MARKER) : null;
    if (fileMatch) { flush(); currentPath = fileMatch[1]; currentLines = []; continue; }
    if (END_MARKER.test(line)) { flush(); currentPath = null; currentLines = null; continue; }
    if (kindMatch) { kind = kindMatch[1]; continue; }
    if (rationaleMatch) { rationale = rationaleMatch[1]; continue; }
    if (currentPath !== null) currentLines.push(line);
    // Lines before the first @@PAC_FILE@@ that aren't a recognized marker (stray prose the
    // model added despite being told not to) are silently ignored, same as extractJson's old
    // "fall back to the outermost span" tolerance.
  }
  flush();
  if (typeof kind !== 'string' || !kind) throw new Error('Model reply missing @@PAC_KIND: ...@@');
  if (kind === 'auto') throw new Error('Model returned kind "auto" — it must resolve auto to a concrete kind');
  if (!Object.keys(files).length) throw new Error('Model reply had no @@PAC_FILE: ...@@ sections');
  return { kind, rationale, files };
}

function stripFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```[a-z]*\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : trimmed;
}
