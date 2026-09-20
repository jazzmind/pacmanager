#!/usr/bin/env node
// Authoring adapter entrypoint: reads one JSON envelope (pacmanager's plugin protocol,
// pacmanager/src/adapters.js) from stdin, writes one JSON result to stdout. This is the
// out-of-process, model-calling plugin behind PAC_AUTHORING_ADAPTER — it never runs inside
// pacmanager's trusted control plane, per docs/plugins.md. Structurally: LiteLLM (or a
// direct-key fallback) for the completion, then a fixed parse -> scaffold pipeline turning the
// model's flat file map into whatever shape pacmanager's authoring contract expects.
import { createProvider } from './lib/provider.js';
import { buildMessages } from './lib/prompt.js';
import { parseGenerationReply } from './lib/parse.js';
import { scaffold } from './lib/scaffold.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.on('data', d => { input += d; if (input.length > 4_000_000) { reject(new Error('Request too large')); process.exit(1); } });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function reply(result) { process.stdout.write(JSON.stringify(result)); }

async function handle(request, provider) {
  const { operation, payload = {} } = request;
  if (operation === 'probe') {
    const probed = await provider.probe();
    return { status: 'ok', output: { available: true, model: probed.model, route: probed.route } };
  }
  if (operation === 'generate') {
    const messages = buildMessages(payload);
    // A provider failure (bad credential, unreachable gateway, truncated by thinking) is left
    // to throw and propagate to the top-level catch below as a plain, non-retriable error --
    // retrying the same request against the same broken gateway/credential wastes the repair
    // budget on something a repair prompt cannot fix. A malformed reply from the model itself
    // is different: that's exactly what the repair loop is for, so it's marked `retriable`
    // (an advisory extension to pacmanager's adapter-result contract, src/adapters.js's
    // validateResult -- it only requires status/message, extra fields pass through) so the
    // host retries it with feedback instead of giving up on the first bad JSON reply.
    const completion = await provider.complete(messages);
    let parsed, scaffolded;
    try { parsed = parseGenerationReply(completion.text); }
    catch (error) { return { status: 'error', message: error.message, retriable: true }; }
    try { scaffolded = scaffold(parsed, payload.workdir); }
    catch (error) { return { status: 'error', message: error.message, retriable: true }; }
    const output = { kind: parsed.kind, model: completion.model };
    if (parsed.rationale) output.rationale = parsed.rationale;
    if (scaffolded.source) output.source = scaffolded.source; else output.sourcePath = scaffolded.sourcePath;
    return { status: 'ok', output };
  }
  throw new Error(`Unsupported authoring operation: ${operation}`);
}

const raw = await readStdin();
try {
  const request = JSON.parse(raw);
  if (request.capability !== 'authoring') throw new Error(`Unsupported capability: ${request.capability}`);
  const provider = createProvider();
  reply(await handle(request, provider));
} catch (error) {
  reply({ status: 'error', message: error.message });
}
