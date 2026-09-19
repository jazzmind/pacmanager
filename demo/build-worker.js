import { compile } from './definition.js';
// The stdin cap must exceed definition.js's own MAX_SOURCE_BYTES (512000) plus JSON envelope
// overhead (keys, escaping, the rest of the definition) -- found live: a real generated
// interactive app (one compiled JS bundle + CSS, ~24KB of source) was rejected here at a stale
// 16000-byte cap despite being well inside the safety gate's actual 512KB limit. 2MB matches
// the same order of magnitude as builders.js's own build-output cap (1,000,000 bytes).
const MAX_INPUT_BYTES = 2_000_000;
try {
  let input = process.env.PAC_BUILD_INPUT || '';
  if (!input) for await (const chunk of process.stdin) { input += chunk; if(input.length>MAX_INPUT_BYTES) throw new Error('Input too large'); }
  const result = compile(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
} catch(error) { console.error(error.message); process.exitCode=1; }
