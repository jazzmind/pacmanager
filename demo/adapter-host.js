import { spawn } from 'node:child_process';

/** Run a plugin adapter out of process: JSON envelope on stdin, one JSON reply on stdout.
 * Mirrors the hardening in builders.js's command() helper (deadline, output cap, minimal env)
 * because an adapter is exactly as untrusted as a build worker. */
export function runAdapter(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Adapter timed out')); }, timeoutMs);
    child.stdout.on('data', b => { output += b; if (output.length > 2_000_000) { child.kill(); reject(new Error('Adapter output too large')); } });
    child.stderr.on('data', b => { error = (error + b).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || `Adapter exited with code ${code}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid adapter response (expected one JSON object on stdout)')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Parse a "command arg1 arg2" config string into a spawn-ready [command, args]. */
export function parseCommandLine(line) {
  const parts = line.split(' ').filter(Boolean);
  if (!parts.length) throw new Error('Empty adapter command');
  return [parts[0], parts.slice(1)];
}
