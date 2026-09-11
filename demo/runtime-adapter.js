import { randomUUID } from 'node:crypto';
import { envelope, validateResult, RUNTIME_CAPABILITIES } from '../src/adapters.js';
import { runAdapter, parseCommandLine } from './adapter-host.js';

/** Build a runtime adapter (the "reconcile release, inspect health, stop, revoke and destroy"
 * plugin type from docs/plugins.md) from PAC_RUNTIME_ADAPTER, a "command arg1 arg2" config
 * string. Returns null when unconfigured; callers must fail closed, not fall back silently. */
export function createRuntimeAdapter(env = process.env) {
  const line = env.PAC_RUNTIME_ADAPTER;
  if (!line) return null;
  const [command, args] = parseCommandLine(line);
  const timeoutMs = Number(env.PAC_RUNTIME_ADAPTER_TIMEOUT_MS || 30000);
  const invoke = (operation, { artifactId, releaseDigest, principalId, payload } = {}) => {
    if (!RUNTIME_CAPABILITIES.includes(operation)) throw new Error(`Unsupported runtime operation: ${operation}`);
    const request = envelope({ requestId: randomUUID(), artifactId, releaseDigest, principalId, capability: 'runtime', operation, payload, deadline: Date.now() + timeoutMs });
    return runAdapter(command, args, request, timeoutMs).then(validateResult);
  };
  const api = { mode: 'adapter: ' + line };
  for (const operation of RUNTIME_CAPABILITIES) api[operation] = args => invoke(operation, args);
  return api;
}
