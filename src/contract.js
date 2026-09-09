import { createHash } from 'node:crypto';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identifier = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(x);
const name = x => typeof x === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(x);
const fields = (x, allowed, at, errors) => {
  if (!object(x)) { errors.push(`${at}: expected object`); return false; }
  for (const key of Object.keys(x)) if (!allowed.includes(key)) errors.push(`${at}: unknown field ${key}`);
  return true;
};

/** Strict alpha contract. Unknown fields fail closed, including policy typos. */
export function validate(a) {
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
  if (!Array.isArray(a.resources)) errors.push('resources must be an array');
  else {
    const seen = new Set();
    for (const r of a.resources) if (fields(r, ['name','type'], 'resource', errors)) {
      if (!identifier(r.name) || seen.has(r.name)) errors.push('invalid or duplicate resource name');
      seen.add(r.name);
      if (!['postgres','pgvector','objects'].includes(r.type)) errors.push('unsupported resource type');
    }
  }
  if (!Array.isArray(a.capabilities)) errors.push('capabilities must be an array');
  else {
    const seen = new Set();
    for (const c of a.capabilities) if (fields(c, ['name','operation','binding'], 'capability', errors)) {
      if (!name(c.name) || !name(c.operation)) errors.push('invalid capability name/operation');
      const key = `${c.name}:${c.operation}`;
      if (seen.has(key)) errors.push('duplicate capability');
      seen.add(key);
      if (!['mock','live'].includes(c.binding)) errors.push('invalid binding');
    }
  }
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
