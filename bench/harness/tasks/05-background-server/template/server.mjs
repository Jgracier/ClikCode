// The inventory service. Runs until it is stopped.
//
//   node server.mjs
//
// It warms its cache first (a few seconds), then picks a free port and prints
// "inventory service listening on http://127.0.0.1:<port>".
//
//   GET /health           -> "ok"
//   GET /token            -> a one-time session token (plain text)
//   GET /stock?sku=<sku>  -> {"sku": ..., "count": ...} (needs header x-token: <token>)
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';

const STOCK = { 'A-100': 17, 'B-220': 0, 'C-310': 42 };
const tokens = new Set();
mkdirSync('.service', { recursive: true });
const record = (entry) => appendFileSync('.service/requests.jsonl', `${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`);

console.log('inventory service: warming cache...');
await new Promise((resolve) => setTimeout(resolve, 3000));

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return response.end('ok');
  if (url.pathname === '/token') {
    const token = randomBytes(6).toString('hex');
    tokens.add(token);
    record({ kind: 'token', token });
    return response.end(token);
  }
  if (url.pathname === '/stock') {
    const token = request.headers['x-token'];
    if (!tokens.has(token)) {
      response.statusCode = 401;
      return response.end('missing or unknown x-token');
    }
    const sku = url.searchParams.get('sku') ?? '';
    if (!(sku in STOCK)) {
      response.statusCode = 404;
      return response.end('unknown sku');
    }
    const answer = { sku, count: STOCK[sku] * 3 + token.length };
    record({ kind: 'stock', ...answer });
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify(answer));
  }
  response.statusCode = 404;
  response.end('not found');
});
server.listen(0, '127.0.0.1', () => {
  console.log(`inventory service listening on http://127.0.0.1:${server.address().port}`);
});
