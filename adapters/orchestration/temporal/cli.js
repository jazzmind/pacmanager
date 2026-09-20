#!/usr/bin/env node
// Orchestration adapter entrypoint: reads one JSON envelope (pacmanager's plugin protocol,
// src/adapters.js, capability "orchestration") from stdin, writes one JSON result to stdout.
// Mirrors adapters/runtime/deploykit/cli.js's shape exactly. Deliberately narrow -- see
// pacmanager's src/adapters.js ORCHESTRATION_OPERATIONS comment: this is the admin console's
// "is Temporal actually reachable and running things" test panel, not a general workflow
// client. Takes the @temporalio/client dependency here, in its own package -- pacmanager's
// demo server stays at zero npm dependencies, per docs/plugins.md's adapter model.
import { Connection, Client } from '@temporalio/client';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.on('data', d => { input += d; if (input.length > 1_000_000) { reject(new Error('Request too large')); process.exit(1); } });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function reply(result) { process.stdout.write(JSON.stringify(result)); }
function env(name, fallback) { return process.env[name] ?? fallback; }

async function connect() {
  const address = env('PAC_TEMPORAL_ADDRESS', 'temporal:7233');
  // A misconfigured address (wrong host, nothing listening) otherwise hangs on the client
  // library's own default connect timeout (~10s) before pacmanager's admin console ever sees
  // an error -- found live while testing this adapter standalone.
  const connection = await Connection.connect({ address, connectTimeout: '5s' });
  const namespace = env('PAC_TEMPORAL_NAMESPACE', 'default');
  return { connection, namespace, address };
}

const OPERATIONS = ['health', 'listWorkflows'];

async function handle(request) {
  const { operation, payload = {} } = request;
  if (!OPERATIONS.includes(operation)) throw new Error(`Unsupported orchestration operation: ${operation}`);
  const { connection, namespace, address } = await connect();
  try {
    switch (operation) {
      case 'health': {
        // describeNamespace is the real proof: a bare TCP connect (what pacmanager's own
        // Services tile falls back to without this adapter configured) can succeed against a
        // port with nothing genuinely serving Temporal behind it. This calls into the actual
        // frontend service and asks it about a real namespace.
        const description = await connection.workflowService.describeNamespace({ namespace });
        return { status: 'ok', output: { address, namespace, namespaceId: description.namespaceInfo?.id || null, state: description.namespaceInfo?.state || 'REGISTERED' } };
      }
      case 'listWorkflows': {
        const client = new Client({ connection, namespace });
        const pageSize = Math.min(50, Number(payload.pageSize) || 10);
        const workflows = [];
        for await (const execution of client.workflow.list()) {
          workflows.push({ workflowId: execution.workflowId, runId: execution.runId, type: execution.type, status: execution.status?.name || null, startTime: execution.startTime?.toISOString?.() || null });
          if (workflows.length >= pageSize) break;
        }
        return { status: 'ok', output: { workflows } };
      }
      default:
        throw new Error(`Unsupported orchestration operation: ${operation}`);
    }
  } finally {
    await connection.close();
  }
}

const raw = await readStdin();
try {
  const request = JSON.parse(raw);
  if (request.capability !== 'orchestration') throw new Error(`Unsupported capability: ${request.capability}`);
  reply(await handle(request));
} catch (error) {
  reply({ status: 'error', message: error.message });
}
