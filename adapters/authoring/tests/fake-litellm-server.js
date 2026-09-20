// A minimal stand-in for the sandbox LiteLLM proxy's OpenAI-compatible /v1/chat/completions
// endpoint, used only to test provider.js/cli.js against something that speaks the real wire
// shape — never against a live proxy. Not exported for production use.
import { createServer } from 'node:http';

export function startFakeLiteLLM({ key = 'test-key', reply = 'ok', status = 200 } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    calls.push({ path: req.url, auth: req.headers.authorization, body: json });
    if (req.headers.authorization !== 'Bearer ' + key) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      const text = typeof reply === 'function' ? reply(json) : reply;
      // A real gateway sometimes returns this exact shape: message.content structurally
      // empty (not a string) with finish_reason "length" -- reproduces the live bug found
      // while testing against the real sandbox proxy (claude-sonnet-5's extended thinking
      // consuming the whole token budget before any answer text). See PROVIDER-007.
      if (text === 'TRUNCATED_BY_THINKING') return res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, thinking_blocks: [{ type: 'thinking', thinking: '' }] } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown route ' + req.url } }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls })));
}
