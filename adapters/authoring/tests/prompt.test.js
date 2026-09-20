import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../lib/prompt.js';

const constraints = { maxFiles: 25, maxBytes: 512000, extensions: ['.html', '.css', '.js', '.json', '.svg'], requiredFiles: ['index.html'], forbidden: ['eval()', 'outbound fetch()'] };

test('PROMPT-001 states the exact constraints passed in, not a hardcoded copy', () => {
  const [, user] = buildMessages({ kind: 'interactive', title: 'Tapper Clone', brief: 'An arcade game.', accent: 'teal', attempt: 1, maxAttempts: 3, constraints });
  assert.match(user.content, /At most 25 files/);
  assert.match(user.content, /512KB/);
  assert.match(user.content, /eval\(\), outbound fetch\(\)/);
  assert.match(user.content, /Tapper Clone/);
});

test('PROMPT-002 tells the model to resolve "auto" itself and requires a rationale', () => {
  const [, user] = buildMessages({ kind: 'auto', title: 'Something', brief: 'Whatever fits best.', accent: 'teal', attempt: 1, maxAttempts: 3, constraints });
  assert.match(user.content, /choose the single best-fitting concrete kind/);
});

test('PROMPT-003 feeds back the previous attempt\'s exact rejected source and issues on retry', () => {
  const [, user] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 2, maxAttempts: 3, constraints, previousAttempt: { source: { 'index.html': '<h1>x</h1>', 'app.js': 'fetch("https://evil.example")' }, issues: ['outbound fetch()'] } });
  assert.match(user.content, /Rejected issues/);
  assert.match(user.content, /outbound fetch\(\)/);
  assert.match(user.content, /fetch\("https:\/\/evil\.example"\)/);
});

test('PROMPT-004 relaxes file-type/network constraints for "application" kind but still requires a Dockerfile', () => {
  const [, user] = buildMessages({ kind: 'application', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {} });
  assert.match(user.content, /working Dockerfile/);
  assert.ok(!user.content.includes('at most 25 files'));
});

test('PROMPT-005 the system message demands the delimited plain-text format, not JSON -- JSON string-escaping multi-line code proved unreliable live (see lib/parse.js)', () => {
  const [system] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints });
  assert.match(system.content, /@@PAC_KIND:/);
  assert.match(system.content, /@@PAC_FILE:/);
  assert.match(system.content, /@@PAC_END@@/);
  assert.match(system.content, /no JSON/); // explicitly told NOT to use JSON, not just left to infer it
});

// Revise, not rewrite (see pacmanager's demo/store.js startGeneration): when the host has an
// existing source map and a specific changeRequest, the model must be told this is a targeted
// edit to real working code, not a fresh interpretation of the brief.

test('PROMPT-006 a revise call (currentSource + changeRequest present) shows the real current files and states the requested change', () => {
  const currentSource = { 'index.html': '<h1>v1</h1>', 'app.js': 'console.log("v1")' };
  const [system, user] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints, currentSource, changeRequest: 'change v1 to v2 everywhere' });
  assert.match(system.content, /Make exactly that change to the real, existing source/);
  assert.match(user.content, /THIS IS A REVISION OF AN EXISTING/);
  assert.match(user.content, /Requested change: change v1 to v2 everywhere/);
  assert.match(user.content, /<h1>v1<\/h1>/); // the actual current file content, verbatim
  assert.match(user.content, /console\.log\("v1"\)/);
  assert.match(user.content, /byte-for-byte identical/); // the "don't touch anything else" instruction
});

test('PROMPT-007 a from-scratch call (no currentSource) never mentions revision at all', () => {
  const [system, user] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints });
  assert.ok(!system.content.includes('existing source'));
  assert.ok(!user.content.includes('THIS IS A REVISION'));
  assert.ok(!user.content.includes('Requested change'));
});

test('PROMPT-008 a revise call still carries a rejected previousAttempt forward (revise + repair are independent, not exclusive)', () => {
  const currentSource = { 'index.html': '<h1>v1</h1>' };
  const previousAttempt = { source: { 'index.html': '<h1>v2 with fetch</h1>' }, issues: ['outbound fetch()'] };
  const [, user] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 2, maxAttempts: 3, constraints, currentSource, changeRequest: 'change v1 to v2', previousAttempt });
  assert.match(user.content, /THIS IS A REVISION/);
  assert.match(user.content, /Your previous attempt was rejected/);
  assert.match(user.content, /outbound fetch\(\)/);
});

test('PROMPT-009 a server capability adds concrete code guidance naming its real env vars; an unguided capability (e.g. "collaborate") adds nothing', () => {
  const [, user] = buildMessages({ kind: 'application', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {}, capabilities: ['shared-data', 'ai-models', 'collaborate'] });
  assert.match(user.content, /DATABASE_URL/);
  assert.match(user.content, /LITELLM_URL/);
  assert.match(user.content, /LITELLM_API_KEY/);
});

test('PROMPT-010 no capabilities means no capabilities block at all', () => {
  const [, user] = buildMessages({ kind: 'interactive', title: 'T', brief: 'B', accent: 'teal', attempt: 1, maxAttempts: 3, constraints: {} });
  assert.ok(!user.content.includes('real capabilities'));
});
