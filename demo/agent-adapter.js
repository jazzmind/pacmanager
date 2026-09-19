import { randomUUID } from 'node:crypto';
import { envelope, validateResult, AGENT_CAPABILITY, AGENT_OPERATIONS } from '../src/adapters.js';
import { runAdapter, parseCommandLine } from './adapter-host.js';

/** Build an agent adapter (Strands, for the admin console's test panel and, later, the
 * chief-of-staff schedule) from PAC_AGENT_ADAPTER, a "command arg1 arg2" config string — same
 * shape as createRuntimeAdapter/createOrchestrationAdapter. Returns null when unconfigured. */
export function createAgentAdapter(env = process.env) {
  const line = env.PAC_AGENT_ADAPTER;
  if (!line) return null;
  const [command, args] = parseCommandLine(line);
  const timeoutMs = Number(env.PAC_AGENT_ADAPTER_TIMEOUT_MS || 60000);
  const invoke = (operation, payload = {}) => {
    if (!AGENT_OPERATIONS.includes(operation)) throw new Error(`Unsupported agent operation: ${operation}`);
    const request = envelope({ requestId: randomUUID(), capability: AGENT_CAPABILITY, operation, payload, deadline: Date.now() + timeoutMs });
    return runAdapter(command, args, request, timeoutMs).then(validateResult);
  };
  const api = { mode: 'adapter: ' + line };
  for (const operation of AGENT_OPERATIONS) api[operation] = payload => invoke(operation, payload);
  return api;
}
