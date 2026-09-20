import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../lib/provider.js';
import { startFakeLiteLLM } from './fake-litellm-server.js';

test('PROVIDER-001 completes via litellm when the key and URL are correct', async t => {
  const { server, port, calls } = await startFakeLiteLLM({ key: 'k1', reply: 'hello from litellm' });
  t.after(() => server.close());
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' });
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello from litellm');
  assert.equal(result.route, 'litellm');
  assert.equal(calls[0].auth, 'Bearer k1');
});

test('PROVIDER-002 falls back to a direct Anthropic key when litellm 401s', async t => {
  const { server, port } = await startFakeLiteLLM({ key: 'right-key', reply: 'unused' });
  t.after(() => server.close());
  const fakeFetch = async (url, opts) => {
    if (String(url).includes('anthropic.com')) {
      return new Response(JSON.stringify({ content: [{ text: 'hello from anthropic' }] }), { status: 200 });
    }
    return fetch(url, opts); // real fetch to the fake litellm server above
  };
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'wrong-key', ANTHROPIC_API_KEY: 'sk-ant-test' }, fakeFetch);
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello from anthropic');
  assert.equal(result.route, 'anthropic-direct');
});

test('PROVIDER-003 falls back to a direct OpenAI key when litellm is unreachable and no Anthropic key is set', async t => {
  const fakeFetch = async url => {
    if (String(url).includes('openai.com')) return new Response(JSON.stringify({ choices: [{ message: { content: 'hello from openai' } }] }), { status: 200 });
    throw new Error('ECONNREFUSED');
  };
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: 'http://127.0.0.1:1', DEPLOYKIT_LITELLM_KEY: 'k', OPENAI_API_KEY: 'sk-test' }, fakeFetch);
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello from openai');
  assert.equal(result.route, 'openai-direct');
});

test('PROVIDER-004 surfaces the litellm error specifically when no fallback key is configured, so an operator knows what to fix', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'Missing Anthropic API Key' } }), { status: 401 });
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: 'http://127.0.0.1:1', DEPLOYKIT_LITELLM_KEY: 'k' }, fakeFetch);
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hi' }]), /litellm 401.*Missing Anthropic API Key/);
});

test('PROVIDER-005 fails closed with a specific message when litellm has no key configured at all', async () => {
  const provider = createProvider({});
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hi' }]), /litellm_not_configured/);
});

test('PROVIDER-007 a real bug found live: claude-sonnet-5 via litellm defaults to extended thinking, which can consume the whole token budget and leave message.content structurally empty (finish_reason "length") -- surfaced as a specific error, and the request explicitly disables thinking to avoid it', async t => {
  const { server, port, calls } = await startFakeLiteLLM({ key: 'k1', reply: 'TRUNCATED_BY_THINKING' });
  t.after(() => server.close());
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' });
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hi' }]), /truncated the response before producing any answer content/);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
});

test('PROVIDER-008 tolerates message.content coming back as an array of blocks instead of a plain string', async t => {
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply: [{ type: 'text', text: 'hello from blocks' }] });
  t.after(() => server.close());
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' });
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello from blocks');
});

test('PROVIDER-006 probe() runs a real (tiny) completion, not just a models list', async t => {
  const { server, port } = await startFakeLiteLLM({ key: 'k1', reply: 'ok' });
  t.after(() => server.close());
  const provider = createProvider({ DEPLOYKIT_LITELLM_URL: `http://127.0.0.1:${port}`, DEPLOYKIT_LITELLM_KEY: 'k1' });
  const result = await provider.probe();
  assert.equal(result.route, 'litellm');
});

test('PROVIDER-009 PAC_LITELLM_URL/PAC_LITELLM_KEY are the canonical env names, taking priority over the deprecated DEPLOYKIT_LITELLM_* fallback', async t => {
  const { server: rightServer, port: rightPort } = await startFakeLiteLLM({ key: 'right-key', reply: 'hello from PAC_LITELLM' });
  t.after(() => rightServer.close());
  const provider = createProvider({
    PAC_LITELLM_URL: `http://127.0.0.1:${rightPort}`, PAC_LITELLM_KEY: 'right-key',
    DEPLOYKIT_LITELLM_URL: 'http://127.0.0.1:1', DEPLOYKIT_LITELLM_KEY: 'wrong-key',
  });
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello from PAC_LITELLM');
});

test('PROVIDER-010 a local-pinned model (local-*) never falls back to a direct cloud vendor call, even when configured and litellm fails', async t => {
  const fakeFetch = async url => {
    if (String(url).includes('anthropic.com') || String(url).includes('openai.com')) {
      throw new Error('should never be called for a local-pinned model');
    }
    throw new Error('ECONNREFUSED'); // litellm itself unreachable
  };
  const provider = createProvider({
    DEPLOYKIT_LITELLM_URL: 'http://127.0.0.1:1', DEPLOYKIT_LITELLM_KEY: 'k',
    PAC_AUTHORING_MODEL: 'local-qwen',
    ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test',
  }, fakeFetch);
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hi' }]), /ECONNREFUSED/);
});

test('PROVIDER-011 a non-local model keeps falling back to direct vendor keys as before', async t => {
  const fakeFetch = async (url, opts) => {
    if (String(url).includes('anthropic.com')) {
      return new Response(JSON.stringify({ content: [{ text: 'hello from anthropic' }] }), { status: 200 });
    }
    throw new Error('ECONNREFUSED');
  };
  const provider = createProvider({
    DEPLOYKIT_LITELLM_URL: 'http://127.0.0.1:1', DEPLOYKIT_LITELLM_KEY: 'k',
    PAC_AUTHORING_MODEL: 'chat',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  }, fakeFetch);
  const result = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.route, 'anthropic-direct');
});
