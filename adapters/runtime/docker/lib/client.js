/**
 * Thin REST + SSE client for deploykit's control plane (sandbox/src/deploykit/service.py).
 * Auth: `Authorization: Bearer <token>` + `X-Deploy-User: <user>` (attribution only —
 * deploykit's own docs note the shared token has no per-user access control at the API
 * layer; see docs/roadmap.md D4). No secret is ever logged or returned in error messages.
 */
export function createDeployKitClient({ apiUrl, token, user, fetchImpl = fetch, timeoutMs = 120000 }) {
  if (!apiUrl) throw new Error('createDeployKitClient requires apiUrl (DEPLOYKIT_API_URL)');
  if (!token) throw new Error('createDeployKitClient requires token (DEPLOYKIT_TOKEN)');
  const base = apiUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Deploy-User': user || 'pacmanager' };

  async function request(method, path, body) {
    const res = await fetchImpl(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`deploykit ${method} ${path} -> ${res.status}: ${data.detail || data.error || text.slice(0, 300)}`);
    return data;
  }

  /** Consume the SSE stream for a deployment_id to completion, returning the terminal
   * DeploymentResult (embedded in the final "complete"/error event's message per docs/api.md)
   * plus the collected log lines. Falls back to polling /status if the stream never resolves
   * within timeoutMs — mirrors the VS Code extension's status-recheck fallback. */
  async function followStream(deploymentId, appId) {
    const res = await fetchImpl(base + `/api/v1/stream/${deploymentId}`, { headers: { Authorization: headers.Authorization, 'X-Deploy-User': headers['X-Deploy-User'] }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return request('GET', `/api/v1/status/${appId}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', logs = [], errored = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const dataLine = block.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          let event; try { event = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          logs.push(event);
          if (event.level === 'error') errored = true;
          if (event.level === 'progress' && /complete/i.test(event.message || '')) { reader.cancel().catch(() => {}); return { result: await request('GET', `/api/v1/status/${appId}`), logs, errored }; }
        }
      }
    } catch { /* stream dropped — fall through to a status check, same as the VS Code extension */ }
    return { result: await request('GET', `/api/v1/status/${appId}`), logs, errored };
  }

  return {
    async deploy(spec, { waitForHealthy = true, timeoutSeconds = 120 } = {}) {
      const { deployment_id, app_id } = await request('POST', '/api/v1/deploy', { spec, wait_for_healthy: waitForHealthy, timeout_seconds: timeoutSeconds });
      return followStream(deployment_id, app_id);
    },
    async sync(appId) {
      const { deployment_id } = await request('POST', `/api/v1/sync/${appId}`);
      return followStream(deployment_id, appId);
    },
    undeploy: (appId, removeVolumes = true) => request('POST', '/api/v1/undeploy', { app_id: appId, remove_volumes: removeVolumes }),
    stop: appId => request('POST', `/api/v1/stop/${appId}`),
    start: appId => request('POST', `/api/v1/start/${appId}`),
    status: appId => request('GET', `/api/v1/status/${appId}`),
    list: () => request('GET', '/api/v1/apps'),
    logs: (appId, tail = 100) => request('GET', `/api/v1/logs/${appId}?tail=${tail}`),
    health: () => request('GET', '/health'),
    setAccess: (appId, allowedEmails) => request('PUT', `/api/v1/access/${appId}`, { allowed_emails: allowedEmails }),
    // Deploy's own auto-provisioning (docker.py's _PROVISIONERS loop) always calls
    // provision_db WITHOUT enable_pgvector, so a plain {{DK_DB_URL}} sentinel alone
    // never gets the extension. Calling this explicitly first is safe: provisioning is
    // idempotent (postgres.py's own docstring), and "CREATE EXTENSION IF NOT EXISTS" persists
    // regardless of the password rotation the later deploy-time call also performs.
    provisionDb: (appId, { enablePgvector = false } = {}) => request('POST', '/api/v1/provision-db', { app_id: appId, enable_pgvector: enablePgvector }),
  };
}
