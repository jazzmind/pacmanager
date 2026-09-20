// A minimal stand-in for LiteLLM's key-management API (/key/generate, /key/delete), shaped to
// match the real proxy's verified behavior: /key/delete 404s ("No keys found") when the alias
// doesn't exist, and /key/generate 400s if the alias is already in use. Used only to test
// lib/litellm-keys.js and cli.js's deploy/undeploy wiring -- never against a live proxy.
import { createServer } from 'node:http';

export function startFakeLiteLLMKeyServer({ masterKey = 'sk-master', existingKeys = [] } = {}) {
  const calls = [];
  const issued = new Map(existingKeys.map(k => [k.key_alias, k]));
  let counter = issued.size;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== 'Bearer ' + masterKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    }
    if (url.pathname === '/key/generate') {
      const json = body ? JSON.parse(body) : {};
      calls.push({ path: '/key/generate', body: json });
      if (issued.has(json.key_alias)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `Key with alias '${json.key_alias}' already exists. Unique key aliases across all keys are required.` } }));
      }
      counter += 1;
      const key = `sk-generated-${counter}`;
      issued.set(json.key_alias, { key_alias: json.key_alias, key });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ key, key_alias: json.key_alias }));
    }
    if (url.pathname === '/key/delete') {
      const json = body ? JSON.parse(body) : {};
      calls.push({ path: '/key/delete', body: json });
      const aliases = json.key_aliases || [];
      const found = aliases.filter(a => issued.has(a));
      if (!found.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "{'error': 'No keys found'}", code: '404' } }));
      }
      for (const alias of found) issued.delete(alias);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ deleted_keys: found }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown route ' + req.url } }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, issued })));
}
