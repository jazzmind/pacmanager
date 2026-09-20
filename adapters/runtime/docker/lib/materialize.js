import { mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Get a PAC release's source onto the same filesystem deploykit's DockerBackend reads
 * from (WORKDIR_BASE, default /srv/deploykit/apps — see deploykit's docker.py). deploykit's
 * `local_path` is only ever a *reference*; something has to put bytes there first.
 *
 * Two payload shapes, matching pacmanager's two source-bearing tiers:
 *  - static tier: `payload.source` is an inline {path: text} map (small, already
 *    digest-verified by pacmanager) — write it out fresh under workdir/<id>.
 *  - app tier: `payload.sourcePath` names a real folder already on disk (the whole
 *    point of the app tier, see plan R2) — symlink workdir/<id> to it rather than
 *    copying, so edits in the real folder are picked up without re-materializing.
 */
// Synthesized deploy-time infra for a materialized static-tier folder -- deploykit's
// DockerBackend always runs `docker build` against local_path (docker.py), so something has
// to put a Dockerfile there. Static-tier source is pacmanager-authored HTML/CSS/JS/JSON/SVG
// only (definition.js's SOURCE_EXT_RE forbids a Dockerfile from ever being part of the
// digest-verified payload.source itself), so this is written directly to disk alongside it,
// never through payload.source's loop -- it is infrastructure, not app content, and is
// deliberately excluded from the source digest for exactly that reason. Found live: every
// static-tier deploy failed at `docker build` with "no such file or directory" for
// Dockerfile before this existed -- the static tier had never actually been deployed against
// a real deploykit instance, only against a fake server in unit tests.
// Port 3000, not nginx's usual 80: found live -- appspec.js defaults every AppSpec's port to
// 3000 (matching the Node-app convention every other app here follows), and toAppSpec has no
// way to know this container is nginx, so a mismatched default here makes deploykit's health
// check probe a port nothing is listening on. Health check timed out after 60s with no error
// surfaced beyond that -- the route was never registered, so nginx correctly fell through to
// its own unmatched-path dashboard instead of the app. Matching the universal default here is
// simpler than teaching appspec.js a tier-conditional one.
const STATIC_DOCKERFILE = 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nCOPY pac-nginx.conf /etc/nginx/conf.d/default.conf\nEXPOSE 3000\n';
const STATIC_NGINX_CONF = 'server {\n  listen 3000;\n  location /health { return 200 "ok"; add_header Content-Type text/plain; }\n  location / { root /usr/share/nginx/html; try_files $uri $uri/ /index.html; }\n}\n';

export function materializeLocal(id, payload, workdir) {
  if (!workdir) throw new Error('materializeLocal requires a workdir (DEPLOYKIT_WORKDIR)');
  const target = join(workdir, id);
  if (payload.source) {
    rmIfExists(target);
    for (const [path, content] of Object.entries(payload.source)) {
      if (path.includes('..') || path.startsWith('/')) throw new Error(`Unsafe source path: ${path}`);
      const full = join(target, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    writeFileSync(join(target, 'Dockerfile'), STATIC_DOCKERFILE, 'utf8');
    writeFileSync(join(target, 'pac-nginx.conf'), STATIC_NGINX_CONF, 'utf8');
    return id;
  }
  if (payload.sourcePath) {
    const real = resolve(payload.sourcePath);
    if (!existsSync(real)) throw new Error(`sourcePath does not exist: ${real}`);
    rmIfExists(target);
    mkdirSync(workdir, { recursive: true });
    symlinkSync(real, target, 'dir');
    return id;
  }
  return null; // image/repoUrl deploys need no materialization
}

function rmIfExists(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true });
}

/** FROZEN 2026-09-20: the remote shared sandbox host is deprecated as a deploy target
 * (local + EKS-via-graduation instead) -- see deploykit/docs/sandbox.md. Not deleted, not
 * actively developed; this path has never been run against a real SSH tunnel to a live host
 * anyway (unit-tested only -- see docs/implementation-status.md), so freezing it costs
 * nothing proven.
 *
 * Sandbox case (plan Step 9): rsync a local app-tier source folder to the sandbox host's
 * app directory over the same SSH alias deploykit's own tooling uses (`sandbox-deploy`),
 * before calling deploy/sync with local_path=id. Mirrors vscode/src/commands/deployApp.ts's
 * rsyncToSandbox, minus the VS Code UI. */
export function materializeRemote(id, sourcePath, { sshAlias = 'sandbox-deploy', remoteAppsDir = '~/deploykit/apps' } = {}) {
  return new Promise((resolve, reject) => {
    const src = sourcePath.endsWith('/') ? sourcePath : sourcePath + '/';
    const dest = `${sshAlias}:${remoteAppsDir}/${id}/`;
    const mkdir = spawn('ssh', [sshAlias, `mkdir -p ${remoteAppsDir}/${id}`]);
    mkdir.on('error', reject);
    mkdir.on('close', code => {
      if (code !== 0) return reject(new Error(`ssh mkdir failed (exit ${code})`));
      const rsync = spawn('rsync', ['-av', '--delete', '-e', `ssh -o StrictHostKeyChecking=accept-new`,
        '--exclude=node_modules', '--exclude=.git', '--exclude=__pycache__', '--exclude=.env',
        '--exclude=dist', '--exclude=build', '--exclude=.next', '--exclude=.deploykit-state',
        src, dest]);
      let err = '';
      rsync.stderr.on('data', d => { err += d; });
      rsync.on('error', reject);
      rsync.on('close', code => code === 0 ? resolve(id) : reject(new Error('rsync failed: ' + err.slice(-2000))));
    });
  });
}
