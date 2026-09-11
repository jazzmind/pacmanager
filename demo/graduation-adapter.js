import { randomUUID } from 'node:crypto';
import { envelope, validateResult, GRADUATION_CAPABILITY } from '../src/adapters.js';
import { runAdapter, parseCommandLine } from './adapter-host.js';

/** Build named graduation adapters (the "source/data/evidence conversion into a named
 * target" plugin type from docs/plugins.md) from PAC_GRADUATION_ADAPTERS, a comma-separated
 * "name=command arg1 arg2" list. Returns an empty Map when unconfigured. */
export function createGraduationAdapters(env = process.env) {
  const spec = env.PAC_GRADUATION_ADAPTERS;
  const adapters = new Map();
  if (!spec) return adapters;
  const timeoutMs = Number(env.PAC_GRADUATION_ADAPTER_TIMEOUT_MS || 60000);
  for (const entry of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new Error(`Invalid PAC_GRADUATION_ADAPTERS entry (expected name=command): ${entry}`);
    const name = entry.slice(0, eq).trim();
    const [command, args] = parseCommandLine(entry.slice(eq + 1).trim());
    adapters.set(name, (files, { artifactId, releaseDigest, principalId } = {}, options = {}) => {
      const request = envelope({ requestId: randomUUID(), artifactId, releaseDigest, principalId, capability: GRADUATION_CAPABILITY, operation: 'graduate', payload: { ...options, files }, deadline: Date.now() + timeoutMs });
      return runAdapter(command, args, request, timeoutMs).then(validateResult);
    });
  }
  return adapters;
}
