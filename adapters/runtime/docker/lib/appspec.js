// Corrected 2026-09-20: "sandbox" describes one deploy target (the shared remote host,
// now frozen/deprecated in favor of local + EKS-via-graduation); it was never a property of
// the resource itself, so pacmanager's OSS default catalog carrying `{{SANDBOX_*}}` tokens
// was a real vocabulary leak. deploykit's postgres.py/dynamodb.py now accept EITHER the old
// `{{SANDBOX_*}}` sentinel or this new, target-neutral `{{DK_*}}` one (see docker.py's
// _PROVISIONERS) -- this adapter emits the new one going forward.
const RESERVED_ENV_SENTINELS = {
  postgres: '{{DK_DB_URL}}',
  // Same underlying per-app Postgres as `postgres` -- the vector extension itself is
  // provisioned explicitly by cli.js's ensurePgvector() before deploy runs, because
  // deploykit's own deploy-time auto-provisioning (docker.py's _PROVISIONERS loop) always
  // calls provision_db() WITHOUT enable_pgvector; only the separate POST /api/v1/provision-db
  // call (which this sentinel alone never triggers) can turn the extension on.
  pgvector: '{{DK_DB_URL}}',
  objects: '{{DK_DDB_ENDPOINT}}',
};

// litellm has no deploykit resource type at all -- deploykit doesn't know it exists, so
// there's no sentinel to substitute server-side. The already-running shared instance is
// reached by injecting plain env vars sourced from THIS adapter's own environment
// (PAC_LITELLM_URL/KEY -- already set on the pacmanager container and inherited by this
// spawned adapter process; see adapter-host.js's env-inheritance fix). DEPLOYKIT_LITELLM_URL/KEY
// is accepted as a deprecated fallback for one release (the two-different-names-for-one-proxy
// risk pracman/docs/architecture.md's "Redundancies" section calls out). A fixed convention
// (LITELLM_URL/LITELLM_API_KEY) is injected alongside whatever variable name the definition
// itself declared, since no application-facing convention for this existed before.
function litellmEnv(env = process.env) {
  return { url: env.PAC_LITELLM_URL || env.DEPLOYKIT_LITELLM_URL, key: env.PAC_LITELLM_KEY || env.DEPLOYKIT_LITELLM_KEY };
}

// temporal has no deploykit resource type either -- confirmed live, zero "temporal" hits
// anywhere in deploykit's own codebase; it's purely a pracman/pacmanager catalog kind, reached
// via a fixed address on the shared docker network (pracman/envs/local/run-temporal.sh), not
// something deploykit provisions per-app. Same pattern as litellm: inject a plain env var
// sourced from this adapter's own environment rather than a server-side sentinel. Previously
// this resource type threw "Unknown resource type" -- pracman/docs/TODO.md's one remaining
// unmapped implemented catalog kind.
function temporalEnv(env = process.env) {
  return { address: env.PAC_TEMPORAL_ADDRESS || 'temporal:7233' };
}

/**
 * Map a PAC Manager deploy payload (see pacmanager's demo/store.js `deployApplication`) to
 * deploykit's AppSpec (sandbox/src/deploykit/models.py). Pure mapping — does not touch the
 * filesystem or the network. Source materialization (writing an inline static-tier file map
 * to disk, or referencing an app-tier folder already on disk) is cli.js's job, because it's
 * an I/O concern and this function needs to stay unit-testable without a filesystem.
 *
 * `payload.envRefs` is a map of {ENV_VAR_NAME: resourceType}; each entry that names a
 * recognized resource type is turned into deploykit's provisioning sentinel token so
 * deploykit — not pacmanager — ever holds the real connection string. Explicit
 * `payload.envVars` values always win over a sentinel for the same key.
 */
export function toAppSpec(payload, { localPath } = {}) {
  const { id: appId, displayName, port, pathPrefix, healthEndpoint, envVars = {}, envRefs = {}, memoryLimit, cpuLimit, syncCapable, image, repoUrl, repoBranch, dockerfile, buildCommand, startCommand } = payload;
  // `payload.id` is the caller's own stable deploy-target slug (pacmanager derives one once
  // per app and reuses it forever — see demo/store.js `slugify` — so a later title edit
  // never repoints status/logs/undeploy at a different deployed app). `payload.displayName`
  // is free-text and may change on every release; it only affects AppSpec.name.
  if (!appId) throw new Error('toAppSpec requires payload.id (a stable deploy-target slug)');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(appId)) throw new Error(`payload.id must be a valid slug (deploykit app id): got ${JSON.stringify(appId)}`);
  if (!image && !repoUrl && !localPath) throw new Error('toAppSpec requires exactly one of image, repoUrl, or a materialized localPath');

  const env_vars = {};
  for (const [key, resourceType] of Object.entries(envRefs)) {
    if (resourceType === 'litellm') {
      const { url, key: litellmKey } = litellmEnv();
      if (!url) throw new Error(`envRefs.${key} requests litellm, but neither PAC_LITELLM_URL nor DEPLOYKIT_LITELLM_URL is configured on the runtime adapter`);
      env_vars[key] = url; env_vars.LITELLM_URL = url; if (litellmKey) env_vars.LITELLM_API_KEY = litellmKey;
      continue;
    }
    if (resourceType === 'temporal') {
      const { address } = temporalEnv();
      env_vars[key] = address; env_vars.TEMPORAL_ADDRESS = address;
      continue;
    }
    const sentinel = RESERVED_ENV_SENTINELS[resourceType];
    if (!sentinel) throw new Error(`Unknown resource type for envRefs.${key}: ${resourceType}`);
    env_vars[key] = sentinel;
  }
  Object.assign(env_vars, envVars); // explicit values always win over a sentinel

  const spec = {
    id: appId,
    name: displayName || appId,
    port: port || 3000,
    path_prefix: pathPrefix || `/${appId}`,
    health_endpoint: healthEndpoint || '/health',
    env_vars,
    memory_limit: memoryLimit || '512m',
    cpu_limit: cpuLimit || '0.5',
    sync_capable: Boolean(syncCapable),
  };
  if (image) spec.image = image;
  else if (repoUrl) { spec.repo_url = repoUrl; if (repoBranch) spec.repo_branch = repoBranch; }
  else spec.local_path = localPath;
  if (dockerfile) spec.dockerfile = dockerfile;
  if (buildCommand) spec.build_command = buildCommand;
  if (startCommand) spec.start_command = startCommand;
  return spec;
}
