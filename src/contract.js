import { createHash } from 'node:crypto';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identifier = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(x);
const name = x => typeof x === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(x);
const fields = (x, allowed, at, errors) => {
  if (!object(x)) { errors.push(`${at}: expected object`); return false; }
  for (const key of Object.keys(x)) if (!allowed.includes(key)) errors.push(`${at}: unknown field ${key}`);
  return true;
};

/** Shared by v1alpha1 and v1alpha2: a named, typed resource list with no duplicate names. */
function validateResourceList(resources, errors) {
  if (!Array.isArray(resources)) { errors.push('resources must be an array'); return; }
  const seen = new Set();
  for (const r of resources) if (fields(r, ['name','type'], 'resource', errors)) {
    if (!identifier(r.name) || seen.has(r.name)) errors.push('invalid or duplicate resource name');
    seen.add(r.name);
    if (!['postgres','pgvector','objects'].includes(r.type)) errors.push('unsupported resource type');
  }
}

/** Shared by v1alpha1 and v1alpha2: capability requests, unique per name+operation. */
function validateCapabilityList(capabilities, errors) {
  if (!Array.isArray(capabilities)) { errors.push('capabilities must be an array'); return; }
  const seen = new Set();
  for (const c of capabilities) if (fields(c, ['name','operation','binding'], 'capability', errors)) {
    if (!name(c.name) || !name(c.operation)) errors.push('invalid capability name/operation');
    const key = `${c.name}:${c.operation}`;
    if (seen.has(key)) errors.push('duplicate capability');
    seen.add(key);
    if (!['mock','live'].includes(c.binding)) errors.push('invalid binding');
  }
}

const TARGETS = ['static', 'service', 'lambda'];

/**
 * v1alpha2: adds a spec.target discriminator so a contract can describe a client-side
 * static bundle or a Lambda handler, not only a digest-pinned network-deny-by-default
 * container. This exists to let the platform runtime/graduation adapters (docs/plugins.md)
 * project a PAC artifact onto Plymouth Rock's own WorkloadDefinition targets without
 * distorting the v1alpha1 container-shaped contract to fit.
 * Target zones: "static" has no server workload at all (sandboxed client-side, per
 * demo/definition.js); "service" is the v1alpha1 container shape, nested under spec;
 * "lambda" trades the container/network fields for a handler path, since the platform
 * itself owns that runtime's network posture.
 */
export function validateV2(a) {
  const errors = [];
  if (!fields(a, ['apiVersion','kind','metadata','spec'], 'artifact', errors)) return errors;
  if (a.apiVersion !== 'pac.jazzmind.dev/v1alpha2') errors.push('unsupported apiVersion');
  if (!['application','agent','knowledge','document','workflow'].includes(a.kind)) errors.push('invalid kind');
  if (fields(a.metadata, ['name','version','owner','description'], 'metadata', errors)) {
    if (!identifier(a.metadata.name)) errors.push('invalid metadata.name');
    if (typeof a.metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(a.metadata.version)) errors.push('version must be x.y.z');
    if (!identifier(a.metadata.owner)) errors.push('invalid owner');
    if (a.metadata.description !== undefined && (typeof a.metadata.description !== 'string' || a.metadata.description.length > 1000)) errors.push('invalid description');
  }
  if (!fields(a.spec, ['target','workload','resources','capabilities','network'], 'spec', errors)) return errors;
  if (!TARGETS.includes(a.spec.target)) { errors.push('invalid spec.target'); return errors; }
  validateResourceList(a.spec.resources, errors);
  validateCapabilityList(a.spec.capabilities, errors);

  if (a.spec.target === 'static') {
    if (a.spec.workload !== undefined) errors.push('spec.workload is not allowed for target static (no server workload)');
    if (a.spec.network !== undefined) errors.push('spec.network is not allowed for target static (no server workload)');
  } else if (a.spec.target === 'service') {
    if (fields(a.spec.workload, ['image','port','cpuMillis','memoryMiB'], 'spec.workload', errors)) {
      if (typeof a.spec.workload.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(a.spec.workload.image)) errors.push('spec.workload.image must be digest-pinned');
      for (const [k, max] of [['port',65535],['cpuMillis',2000],['memoryMiB',2048]]) {
        if (!Number.isInteger(a.spec.workload[k]) || a.spec.workload[k] < 1 || a.spec.workload[k] > max) errors.push(`invalid spec.workload.${k}`);
      }
    }
    if (fields(a.spec.network, ['inbound','outbound'], 'spec.network', errors)) {
      if (a.spec.network.inbound !== 'deny' || a.spec.network.outbound !== 'deny') errors.push('spec.network must default deny both directions');
    }
  } else if (a.spec.target === 'lambda') {
    if (fields(a.spec.workload, ['handler','memoryMiB','cpuMillis'], 'spec.workload', errors)) {
      if (typeof a.spec.workload.handler !== 'string' || !/^[a-zA-Z0-9_./-]+\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(a.spec.workload.handler)) errors.push('spec.workload.handler must be a module.export path, e.g. src/api/index.handler');
      if (a.spec.workload.memoryMiB !== undefined && (!Number.isInteger(a.spec.workload.memoryMiB) || a.spec.workload.memoryMiB < 128 || a.spec.workload.memoryMiB > 10240)) errors.push('invalid spec.workload.memoryMiB');
      if (a.spec.workload.cpuMillis !== undefined && (!Number.isInteger(a.spec.workload.cpuMillis) || a.spec.workload.cpuMillis < 1 || a.spec.workload.cpuMillis > 2000)) errors.push('invalid spec.workload.cpuMillis');
    }
    if (a.spec.network !== undefined) errors.push('spec.network is not allowed for target lambda (network posture is platform-managed)');
  }
  return errors;
}

/** Strict alpha contract. Unknown fields fail closed, including policy typos.
 * Dispatches to validateV2 for apiVersion pac.jazzmind.dev/v1alpha2; the v1alpha1 path
 * below is otherwise byte-identical to the original scaffold validator. */
export function validate(a) {
  if (object(a) && a.apiVersion === 'pac.jazzmind.dev/v1alpha2') return validateV2(a);
  const errors = [];
  if (!fields(a, ['apiVersion','kind','metadata','workload','resources','capabilities','network'], 'artifact', errors)) return errors;
  if (a.apiVersion !== 'pac.jazzmind.dev/v1alpha1') errors.push('unsupported apiVersion');
  if (!['application','agent','knowledge','document','workflow'].includes(a.kind)) errors.push('invalid kind');
  if (fields(a.metadata, ['name','version','owner','description'], 'metadata', errors)) {
    if (!identifier(a.metadata.name)) errors.push('invalid metadata.name');
    if (typeof a.metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(a.metadata.version)) errors.push('version must be x.y.z');
    if (!identifier(a.metadata.owner)) errors.push('invalid owner');
    if (a.metadata.description !== undefined && (typeof a.metadata.description !== 'string' || a.metadata.description.length > 1000)) errors.push('invalid description');
  }
  if (fields(a.workload, ['image','port','cpuMillis','memoryMiB'], 'workload', errors)) {
    if (typeof a.workload.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(a.workload.image)) errors.push('image must be digest-pinned');
    for (const [k,max] of [['port',65535],['cpuMillis',2000],['memoryMiB',2048]]) {
      if (!Number.isInteger(a.workload[k]) || a.workload[k] < 1 || a.workload[k] > max) errors.push(`invalid workload.${k}`);
    }
  }
  if (fields(a.network, ['inbound','outbound'], 'network', errors)) {
    if (a.network.inbound !== 'deny' || a.network.outbound !== 'deny') errors.push('network must default deny both directions');
  }
  validateResourceList(a.resources, errors);
  validateCapabilityList(a.capabilities, errors);
  return errors;
}

export function assertValid(a) {
  const errors = validate(a);
  if (errors.length) throw new Error(errors.join('; '));
  return a;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(a) {
  assertValid(a);
  return createHash('sha256').update(canonical(a)).digest('hex');
}
