#!/usr/bin/env node
// A tiny stdio MCP server for tests: newline-delimited JSON-RPC, the three
// methods a tool-calling client uses, and a few tools that misbehave on
// purpose. Behaviour switches come from the environment so one script
// serves every case.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));
if (process.env.FAKE_MCP_FAIL_START) {
  process.stderr.write('fatal: could not open the database at /nowhere\n');
  process.exit(2);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const TOOLS = [
  { name: 'echo', description: 'Echoes its text back.', annotations: { readOnlyHint: true },
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always reports a tool error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'explode', description: 'Answers with a JSON-RPC error.', inputSchema: { type: 'object' } },
  { name: 'crash', description: 'Exits mid-call.' },
  { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object' } },
  { name: 'picture', description: 'Returns an image and a resource.', annotations: { readOnlyHint: false } },
  { name: 'structured', description: 'Returns only structured content.' },
  { name: 'weird.name/with spaces', description: 'A name no model API accepts.' },
];

let cancelled = [];

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') { cancelled.push(message.params.requestId); return; }
  if (message.id === undefined) return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  }
  if (method === 'tools/list') {
    // Two pages, to prove the client follows the cursor.
    if (!params?.cursor) return send({ id, result: { tools: TOOLS.slice(0, 3), nextCursor: 'page2' } });
    return send({ id, result: { tools: TOOLS.slice(3) } });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (name === 'echo') return send({ id, result: { content: [{ type: 'text', text: `echo: ${params.arguments.text}` }, { type: 'text', text: `cancelled so far: ${cancelled.join(',') || 'none'}` }] } });
    if (name === 'fail') return send({ id, result: { content: [{ type: 'text', text: 'the widget is jammed' }], isError: true } });
    if (name === 'explode') return send({ id, error: { code: -32000, message: 'kaboom' } });
    if (name === 'crash') { process.stderr.write('segfault in module frobnicate\n'); process.exit(3); }
    if (name === 'slow') return;
    if (name === 'picture') {
      return send({ id, result: { content: [
        { type: 'image', data: Buffer.alloc(3000).toString('base64'), mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///tmp/report.pdf', mimeType: 'application/pdf', blob: 'AAAA' } },
        { type: 'resource_link', uri: 'file:///tmp/x.txt', name: 'x.txt' },
      ] } });
    }
    if (name === 'structured') return send({ id, result: { structuredContent: { temperature: 21 } } });
    if (name === 'weird.name/with spaces') return send({ id, result: { content: [{ type: 'text', text: 'weird ok' }] } });
    return send({ id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
  send({ id, error: { code: -32601, message: `unknown method ${method}` } });
});
