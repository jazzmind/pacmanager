// A minimal stand-in for deploykit's REST + SSE control plane, used only to test this
// adapter's HTTP/SSE handling against something that speaks the real wire shape — never
// against a live sandbox. Not exported for production use.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export function startFakeDeployKit({ token = 'test-token', failDeploy = false } = {}) {
  const apps = new Map();
  const deployments = new Map();
  const calls = [];

  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== 'Bearer ' + token) { res.writeHead(401); return res.end('{"detail":"unauthorized"}'); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://localhost');
    const respond = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    calls.push({ method: req.method, path: url.pathname, body: json, user: req.headers['x-deploy-user'] });

    if (req.method === 'POST' && url.pathname === '/api/v1/deploy') {
      const deploymentId = randomUUID(), appId = json.spec.id;
      apps.set(appId, { app_id: appId, name: json.spec.name, status: 'running', url: `http://localhost/${appId}/`, port: 4100, deployed_at: Date.now() / 1000 });
      deployments.set(deploymentId, { appId, spec: json.spec });
      return respond(202, { deployment_id: deploymentId, app_id: appId });
    }
    const syncMatch = url.pathname.match(/^\/api\/v1\/sync\/(.+)$/);
    if (req.method === 'POST' && syncMatch) {
      const appId = syncMatch[1];
      if (!apps.has(appId)) return respond(404, { detail: 'no existing container' });
      const deploymentId = randomUUID();
      deployments.set(deploymentId, { appId, spec: null });
      return respond(202, { deployment_id: deploymentId, app_id: appId });
    }
    const streamMatch = url.pathname.match(/^\/api\/v1\/stream\/(.+)$/);
    if (req.method === 'GET' && streamMatch) {
      const deployment = deployments.get(streamMatch[1]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const send = (level, message) => res.write(`event: log\ndata: ${JSON.stringify({ ts: Date.now() / 1000, level, message, deployment_id: streamMatch[1] })}\n\n`);
      send('info', 'Port allocated');
      if (deployment && failDeploy) { send('error', 'Docker build failed: exit 1'); }
      else { send('progress', 'complete'); }
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/undeploy') {
      apps.delete(json.app_id);
      return respond(200, { deployment_id: randomUUID(), app_id: json.app_id, status: 'removed' });
    }
    const stopMatch = url.pathname.match(/^\/api\/v1\/stop\/(.+)$/);
    if (req.method === 'POST' && stopMatch) return respond(200, { deployment_id: randomUUID(), app_id: stopMatch[1], status: 'stopped' });
    const startMatch = url.pathname.match(/^\/api\/v1\/start\/(.+)$/);
    if (req.method === 'POST' && startMatch) return respond(200, { deployment_id: randomUUID(), app_id: startMatch[1], status: 'running' });
    const statusMatch = url.pathname.match(/^\/api\/v1\/status\/(.+)$/);
    if (req.method === 'GET' && statusMatch) {
      const app = apps.get(statusMatch[1]);
      if (!app) return respond(404, { detail: 'not found' });
      return respond(200, { deployment_id: randomUUID(), app_id: app.app_id, status: app.status, url: app.url, port: app.port, container_id: 'abc123', error: null, created_at: app.deployed_at });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/apps') return respond(200, [...apps.values()]);
    const logsMatch = url.pathname.match(/^\/api\/v1\/logs\/(.+)$/);
    if (req.method === 'GET' && logsMatch) return respond(200, { app_id: logsMatch[1], logs: 'fake log line 1\nfake log line 2\n' });
    const accessMatch = url.pathname.match(/^\/api\/v1\/access\/(.+)$/);
    if (req.method === 'PUT' && accessMatch) return respond(200, { app_id: accessMatch[1], allowed_emails: json.allowed_emails });
    if (req.method === 'POST' && url.pathname === '/api/v1/provision-db') return respond(200, { app_id: json.app_id, db_url: 'postgresql://fake/' + json.app_id, enable_pgvector: json.enable_pgvector });
    if (req.method === 'GET' && url.pathname === '/health') return respond(200, { status: 'ok' });
    respond(404, { detail: 'unknown route ' + url.pathname });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, apps })));
}
