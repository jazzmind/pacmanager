// Test-double adapter: reads one JSON envelope from stdin, echoes a canned reply.
// Behavior is driven by request.payload.testMode (not env vars) because adapter-host.js
// deliberately strips the child process's environment down to PATH/HOME.
process.stdin.resume();
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const mode = request.payload && request.payload.testMode;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; } // keep the event loop alive -> exercises timeout
  if (mode === 'garbage') { process.stdout.write('not json'); return; }
  if (mode === 'crash') { process.stderr.write('boom'); process.exitCode = 1; return; }
  if (mode === 'bad-shape') { process.stdout.write(JSON.stringify({ nope: true })); return; }
  process.stdout.write(JSON.stringify({ status: 'ok', output: { echoedOperation: request.operation, echoedPayload: request.payload, receivedCapability: request.capability } }));
});
