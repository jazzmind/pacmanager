import { randomUUID } from 'node:crypto';
import { envelope, validateResult, AUTHORING_CAPABILITY, AUTHORING_OPERATIONS } from '../src/adapters.js';
import { runAdapter, parseCommandLine } from './adapter-host.js';

/** Build an authoring adapter (the model-calling "generate" plugin — genuinely new, not the
 * "client transport adapter" type in docs/plugins.md, formerly also named "authoring adapter"
 * there before this capability's rename; that one describes a transport mapping, not a
 * generator; see docs/implementation-status.md) from PAC_AUTHORING_ADAPTER, a
 * "command arg1 arg2" config string. Returns null when unconfigured; callers (store.js's
 * requireAuthoring()) must fail closed with a specific, actionable message, never fall back
 * to a template.
 *
 * Two operations with different timeout budgets: `generate` is a real model call (default
 * 180s, generous — the model may need to write several files); `probe` is a cheap
 * reachability check (default 10s) used to populate GET /api/me's cached availability state
 * without ever blocking a page load on a model call. */
export function createAuthoringAdapter(env = process.env) {
  const line = env.PAC_AUTHORING_ADAPTER;
  if (!line) return null;
  const [command, args] = parseCommandLine(line);
  const generateTimeoutMs = Number(env.PAC_AUTHORING_ADAPTER_TIMEOUT_MS || 180000);
  const probeTimeoutMs = Number(env.PAC_AUTHORING_PROBE_TIMEOUT_MS || 10000);
  const invoke = (operation, timeoutMs, { artifactId, principalId, payload } = {}) => {
    if (!AUTHORING_OPERATIONS.includes(operation)) throw new Error(`Unsupported authoring operation: ${operation}`);
    const request = envelope({ requestId: randomUUID(), artifactId, principalId, capability: AUTHORING_CAPABILITY, operation, payload, deadline: Date.now() + timeoutMs });
    return runAdapter(command, args, request, timeoutMs).then(validateResult);
  };
  return {
    mode: 'authoring adapter: ' + line,
    generate: args => invoke('generate', generateTimeoutMs, args),
    probe: () => invoke('probe', probeTimeoutMs, { payload: {} }),
  };
}
