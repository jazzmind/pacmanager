import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerationReply } from '../lib/parse.js';

test('PARSE-001 parses a clean reply with no fences', () => {
  const out = parseGenerationReply('@@PAC_KIND: interactive@@\n@@PAC_FILE: index.html@@\n<h1>hi</h1>\n@@PAC_END@@');
  assert.equal(out.kind, 'interactive');
  assert.deepEqual(out.files, { 'index.html': '<h1>hi</h1>' });
});

test('PARSE-002 strips a stray ``` fence models add despite being told not to', () => {
  const text = 'Sure, here you go:\n```\n@@PAC_KIND: interactive@@\n@@PAC_FILE: index.html@@\n<h1>hi</h1>\n@@PAC_END@@\n```\nEnjoy!';
  const out = parseGenerationReply(text);
  assert.equal(out.kind, 'interactive');
});

test('PARSE-003 preserves multi-line file content verbatim, including literal newlines and characters that would break JSON string escaping', () => {
  const text = [
    '@@PAC_KIND: interactive@@',
    '@@PAC_FILE: app.js@@',
    'function greet(name) {',
    '  return "Hi, " + name + "!";',
    '}',
    '// a "quoted" string, a backslash \\ and a tab\tcharacter, all literal',
    '@@PAC_END@@',
  ].join('\n');
  const out = parseGenerationReply(text);
  assert.equal(out.files['app.js'], 'function greet(name) {\n  return "Hi, " + name + "!";\n}\n// a "quoted" string, a backslash \\ and a tab\tcharacter, all literal');
});

test('PARSE-004 rejects a reply that never resolved "auto" to a concrete kind', () => {
  assert.throws(() => parseGenerationReply('@@PAC_KIND: auto@@\n@@PAC_FILE: index.html@@\nx\n@@PAC_END@@'), /resolve auto/);
});

test('PARSE-005 rejects a reply with no files', () => {
  assert.throws(() => parseGenerationReply('@@PAC_KIND: interactive@@\n@@PAC_END@@'), /no @@PAC_FILE/);
});

test('PARSE-006 rejects a reply missing the kind marker entirely', () => {
  assert.throws(() => parseGenerationReply('@@PAC_FILE: index.html@@\n<h1>hi</h1>\n@@PAC_END@@'), /missing @@PAC_KIND/);
});

test('PARSE-007 carries a rationale through when present', () => {
  const out = parseGenerationReply('@@PAC_KIND: application@@\n@@PAC_RATIONALE: best fit@@\n@@PAC_FILE: Dockerfile@@\nFROM scratch\n@@PAC_END@@');
  assert.equal(out.rationale, 'best fit');
});

test('PARSE-008 parses multiple files correctly, each stopping at the next marker', () => {
  const text = ['@@PAC_KIND: interactive@@', '@@PAC_FILE: index.html@@', '<h1>hi</h1>', '@@PAC_FILE: styles.css@@', 'h1 { color: red; }', '@@PAC_END@@'].join('\n');
  const out = parseGenerationReply(text);
  assert.deepEqual(out.files, { 'index.html': '<h1>hi</h1>', 'styles.css': 'h1 { color: red; }' });
});

test('PARSE-009 ignores stray prose before the first marker', () => {
  const text = ['Here is the app you asked for:', '@@PAC_KIND: interactive@@', '@@PAC_FILE: index.html@@', '<h1>hi</h1>', '@@PAC_END@@'].join('\n');
  const out = parseGenerationReply(text);
  assert.equal(out.kind, 'interactive');
});
