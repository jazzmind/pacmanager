import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = req.url === '/health' || req.url === '/' ? 200 : 404;
  res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : req.url === '/' ? { message: 'Portable service starter' } : { error: 'not-found' }));
});
server.listen(8080, '127.0.0.1');
process.on('SIGTERM', () => server.close());

