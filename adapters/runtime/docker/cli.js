#!/usr/bin/env node
// Runtime adapter entrypoint: reads one JSON envelope (pacmanager's plugin protocol,
// src/adapters.js) from stdin, writes one JSON result to stdout. Translates pacmanager's
// 10 runtime capabilities onto deploykit's REST API — this process never runs a build or
// touches nginx itself; it only asks deploykit's control plane to do so.
import { toAppSpec } from './lib/appspec.js';
import { createDeployKitClient } from './lib/client.js';
import { materializeLocal, materializeRemote } from './lib/materialize.js';
import { ensureAppKey, revokeAppKey } from './lib/litellm-keys.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.on('data', d => { input += d; if (input.length > 8_000_000) { reject(new Error('Request too large')); process.exit(1); } });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function reply(result) { process.stdout.write(JSON.stringify(result)); }

function env(name, fallback) { return process.env[name] ?? fallback; }

async function resolveLocalPath(payload) {
  if (payload.image || payload.repoUrl) return null; // no materialization needed
  const remote = env('DEPLOYKIT_REMOTE') === '1';
  if (remote) {
    if (!payload.sourcePath) throw new Error('DEPLOYKIT_REMOTE=1 requires payload.sourcePath (inline static-tier source is not supported over the remote path yet)');
    return materializeRemote(payload.id, payload.sourcePath, {
      sshAlias: env('DEPLOYKIT_SSH_ALIAS', 'sandbox-deploy'),
      remoteAppsDir: env('DEPLOYKIT_REMOTE_APPS_DIR', '~/deploykit/apps'),
    });
  }
  const workdir = env('DEPLOYKIT_WORKDIR');
  if (!workdir) throw new Error('DEPLOYKIT_WORKDIR is required to materialize a static-tier or app-tier source locally');
  return materializeLocal(payload.id, payload, workdir);
}

async function handle(request) {
  const { operation, payload = {} } = request;
  const client = createDeployKitClient({ apiUrl: env('DEPLOYKIT_API_URL', 'http://localhost:8011'), token: env('DEPLOYKIT_TOKEN'), user: env('DEPLOYKIT_USER', 'pacmanager') });
  switch (operation) {
    case 'deploy': {
      const localPath = await resolveLocalPath(payload);
      // If this app wants AI models, mint a scoped, budgeted LiteLLM virtual key for
      // it instead of letting appspec.js inject the shared master key verbatim -- see
      // lib/litellm-keys.js for why that matters. An explicit payload.envVars value for the
      // same key still wins (Object.assign order in toAppSpec is unchanged), so a caller that
      // deliberately wants the master key (or a hand-issued key) can still override this.
      const wantsLitellm = Object.values(payload.envRefs || {}).includes('litellm');
      const litellmUrl = env('PAC_LITELLM_URL', env('DEPLOYKIT_LITELLM_URL'));
      const litellmMasterKey = env('PAC_LITELLM_KEY', env('DEPLOYKIT_LITELLM_KEY'));
      let scopedKeyEnvVars;
      if (wantsLitellm && litellmUrl && litellmMasterKey) {
        try {
          const { key } = await ensureAppKey(payload.id, {
            litellmUrl, masterKey: litellmMasterKey,
            maxBudget: payload.litellmMaxBudget, rpmLimit: payload.litellmRpmLimit, tpmLimit: payload.litellmTpmLimit,
          });
          scopedKeyEnvVars = { LITELLM_API_KEY: key };
        } catch (error) {
          // Fail closed, not open: an app that can't get a scoped key must not silently fall
          // back to the shared master key (that would quietly undo the whole point of this).
          return { status: 'error', message: `Failed to issue a scoped LiteLLM key for ${payload.id}: ${error.message}` };
        }
      }
      const spec = toAppSpec({ ...payload, envVars: { ...scopedKeyEnvVars, ...payload.envVars } }, { localPath });
      // See lib/appspec.js's RESERVED_ENV_SENTINELS.pgvector comment: deploy's own
      // auto-provisioning never enables the extension, only this explicit call does.
      if (Object.values(payload.envRefs || {}).includes('pgvector')) await client.provisionDb(payload.id, { enablePgvector: true });
      // Mirrors deploykit's own documented client convention (docs/api.md, and
      // vscode/src/commands/deployApp.ts): a sync-capable app that's already running gets
      // a fast in-place restart via /sync — no docker build, seconds not minutes — falling
      // back to a full /deploy only when there's no existing container to sync into yet,
      // or it predates sync_capable support.
      if (spec.sync_capable) {
        try {
          const outcome = await client.sync(spec.id);
          return outcome.errored ? { status: 'error', message: summarizeFailure(outcome) } : { status: 'ok', output: outcome.result };
        } catch (error) {
          if (!/no existing container|predates.*sync.?capable/i.test(error.message)) throw error;
        }
      }
      const outcome = await client.deploy(spec);
      return outcome.errored ? { status: 'error', message: summarizeFailure(outcome) } : { status: 'ok', output: outcome.result };
    }
    case 'sync': {
      if (!payload.id) throw new Error('sync requires payload.id');
      if (payload.sourcePath && env('DEPLOYKIT_REMOTE') === '1') await materializeRemote(payload.id, payload.sourcePath, { sshAlias: env('DEPLOYKIT_SSH_ALIAS', 'sandbox-deploy'), remoteAppsDir: env('DEPLOYKIT_REMOTE_APPS_DIR', '~/deploykit/apps') });
      const outcome = await client.sync(payload.id);
      return outcome.errored ? { status: 'error', message: summarizeFailure(outcome) } : { status: 'ok', output: outcome.result };
    }
    case 'undeploy': {
      if (!payload.id) throw new Error('undeploy requires payload.id');
      const output = await client.undeploy(payload.id, payload.removeVolumes !== false);
      // Best-effort: revoke any scoped LiteLLM key this app was issued, mirroring deploykit's
      // own posture of independently try/excepted teardown steps (see lib/litellm-keys.js).
      const litellmUrl = env('PAC_LITELLM_URL', env('DEPLOYKIT_LITELLM_URL'));
      const litellmMasterKey = env('PAC_LITELLM_KEY', env('DEPLOYKIT_LITELLM_KEY'));
      if (litellmUrl && litellmMasterKey) await revokeAppKey(payload.id, { litellmUrl, masterKey: litellmMasterKey });
      return { status: 'ok', output };
    }
    case 'stop':
      if (!payload.id) throw new Error('stop requires payload.id');
      return { status: 'ok', output: await client.stop(payload.id) };
    case 'start':
      if (!payload.id) throw new Error('start requires payload.id');
      return { status: 'ok', output: await client.start(payload.id) };
    case 'status':
      if (!payload.id) throw new Error('status requires payload.id');
      return { status: 'ok', output: await client.status(payload.id) };
    case 'list':
      return { status: 'ok', output: { apps: await client.list() } };
    case 'logs':
      if (!payload.id) throw new Error('logs requires payload.id');
      return { status: 'ok', output: await client.logs(payload.id, payload.tail || 100) };
    case 'health':
      return { status: 'ok', output: await client.health() };
    case 'setAccess':
      if (!payload.id) throw new Error('setAccess requires payload.id');
      return { status: 'ok', output: await client.setAccess(payload.id, payload.allowedEmails || []) };
    default:
      throw new Error(`Unsupported runtime operation: ${operation}`);
  }
}

function summarizeFailure(outcome) {
  const last = outcome.logs.filter(l => l.level === 'error').at(-1);
  return last?.message || outcome.result?.error || 'Deployment failed';
}

const raw = await readStdin();
try {
  const request = JSON.parse(raw);
  if (request.capability !== 'runtime') throw new Error(`Unsupported capability: ${request.capability}`);
  reply(await handle(request));
} catch (error) {
  reply({ status: 'error', message: error.message });
}
