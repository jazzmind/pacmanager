// Test-double authoring adapter: reads one JSON envelope from stdin, echoes a canned reply
// driven by request.payload.testMode. Mirrors fixtures/echo-adapter.js's shape for the
// authoring capability specifically (two operations: generate, probe).
process.stdin.resume();
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const mode = request.payload && request.payload.testMode;
  if (mode === 'not_configured') { process.stdout.write(JSON.stringify({ status: 'error', message: 'not_configured' })); return; }
  if (mode === 'gateway_unreachable') { process.stdout.write(JSON.stringify({ status: 'error', message: 'gateway_unreachable: ECONNREFUSED' })); return; }
  if (mode === 'bad-output') { process.stdout.write(JSON.stringify({ status: 'ok', output: { kind: 'nonsense' } })); return; }
  if (request.operation === 'probe') { process.stdout.write(JSON.stringify({ status: 'ok', output: { available: true } })); return; }
  // Default: a well-formed 'generate' reply, always producing the same trivial page.
  process.stdout.write(JSON.stringify({
    status: 'ok',
    output: { kind: 'interactive', model: 'test-model', source: { 'index.html': '<h1>Generated</h1>' } },
  }));
});
