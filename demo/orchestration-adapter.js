import { randomUUID } from 'node:crypto';
import { envelope, validateResult, ORCHESTRATION_CAPABILITY, ORCHESTRATION_OPERATIONS } from '../src/adapters.js';
import { runAdapter, parseCommandLine } from './adapter-host.js';

/** Build an orchestration adapter (Temporal, for the admin console's test panel) from
 * PAC_ORCHESTRATION_ADAPTER, a "command arg1 arg2" config string — same shape as
 * createRuntimeAdapter. Returns null when unconfigured; callers must fail closed. */
export function createOrchestrationAdapter(env = process.env) {
  const line = env.PAC_ORCHESTRATION_ADAPTER;
  if (!line) return null;
  const [command, args] = parseCommandLine(line);
  const timeoutMs = Number(env.PAC_ORCHESTRATION_ADAPTER_TIMEOUT_MS || 15000);
  const invoke = (operation, payload = {}) => {
    if (!ORCHESTRATION_OPERATIONS.includes(operation)) throw new Error(`Unsupported orchestration operation: ${operation}`);
    const request = envelope({ requestId: randomUUID(), capability: ORCHESTRATION_CAPABILITY, operation, payload, deadline: Date.now() + timeoutMs });
    return runAdapter(command, args, request, timeoutMs).then(validateResult);
  };
  const api = { mode: 'adapter: ' + line };
  for (const operation of ORCHESTRATION_OPERATIONS) api[operation] = payload => invoke(operation, payload);
  return api;
}
