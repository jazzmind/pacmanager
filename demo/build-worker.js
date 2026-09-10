import { compile } from './definition.js';
try {
  let input = process.env.PAC_BUILD_INPUT || '';
  if (!input) for await (const chunk of process.stdin) { input += chunk; if(input.length>16000) throw new Error('Input too large'); }
  const result = compile(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
} catch(error) { console.error(error.message); process.exitCode=1; }
