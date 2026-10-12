#!/usr/bin/env node
/* A stand-in for the ClikDeploy Gateway's OpenAI-compatible API, for the TUI
 * end-to-end rig: `POST /v1/chat/completions` as an SSE stream, `GET /v1/models`.
 * It never leaves loopback and holds no credential (any bearer is accepted).
 *
 * What a request does is chosen by the last user message (the prompt the
 * scenario typed), so one server serves every scenario:
 *   contains `GW-PLAIN`   reasoning, text, usage with cost, stop
 *   contains `GW-TOOLS`   reasoning, text, TWO parallel read-only tool calls
 *                         (the second one's arguments arrive in fragments),
 *                         then -- when the results are in -- closing text
 *   contains `GW-402`     HTTP 402 insufficient_credits
 *   contains `GW-5XX`     HTTP 503 on the first request, then as GW-PLAIN
 *   contains `GW-SLOW`    text in 40 ms pieces for ~2 s (steer / cancel)
 * Every request is appended to GATEWAY_FAKE_LOG (JSONL, Date.now() ms) with
 * the moment the request arrived and when each frame was written, so the rig
 * can subtract the server's own time from ClikCode's.
 *
 *   node fake-gateway.mjs PORT_FILE   (prints and writes the port it bound) */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const log = (record) => { if (process.env.GATEWAY_FAKE_LOG) appendFileSync(process.env.GATEWAY_FAKE_LOG, `${JSON.stringify({ t: Date.now(), ...record })}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sentFirst = new Set();
const MODEL = 'fake-gateway-model';

const lastUser = (messages) => {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role !== 'user') continue;
    return typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join('');
  }
  return '';
};

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'auto', root: MODEL }, { id: MODEL, context_length: 200000, max_output_tokens: 8000 }] }));
    return;
  }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) { response.writeHead(404).end('{}'); return; }
  const arrived = Date.now();
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  const prompt = messages.filter((message) => message.role === 'user').map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join(''))).join('\n');
  const afterTools = messages[messages.length - 1]?.role === 'tool';
  log({ ev: 'request', arrived, afterTools, messages: messages.length, steer: lastUser(messages).includes('steer-now') });

  const fail = (status, error, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify({ error })); log({ ev: 'fail', status }); };
  if (!afterTools && prompt.includes('GW-402')) { fail(402, { message: 'You are out of Gateway credit', code: 'insufficient_credits' }); return; }
  if (!afterTools && prompt.includes('GW-5XX') && !sentFirst.has('5xx')) { sentFirst.add('5xx'); fail(503, { message: 'upstream unavailable', code: 'upstream_error' }, { 'retry-after': '1' }); return; }

  response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake' });
  const send = (delta, extra = {}, finish = null) => {
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    log({ ev: 'frame', delta: JSON.stringify(delta).slice(0, 60) });
  };
  const usage = (input, output, cost) => ({ usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, cost } });
  const finish = (reason, extra) => { send({}, extra, reason); response.write('data: [DONE]\n\n'); response.end(); log({ ev: 'end' }); };

  if (afterTools) {
    for (const word of ['Both ', 'reads ', 'came ', 'back ', 'fine.']) { send({ content: word }); await sleep(20); }
    finish('stop', usage(2600, 40, 0.0031));
    return;
  }
  send({ role: 'assistant', content: '' });
  for (const word of ['Weighing ', 'the ', 'options ', 'first. ']) { send({ reasoning_content: word }); await sleep(15); }
  if (prompt.includes('GW-SLOW')) {
    for (let piece = 0; piece < 50; piece += 1) { send({ content: `word${piece} ` }); await sleep(40); }
    finish('stop', usage(900, 120, 0.0012));
    return;
  }
  for (const word of ['Starting ', 'the ', 'work ', 'now. ']) { send({ content: word }); await sleep(15); }
  if (prompt.includes('GW-TOOLS')) {
    send({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"alpha.txt"}' } }] });
    send({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] });
    await sleep(60);
    send({ tool_calls: [{ index: 1, function: { arguments: '"beta.txt"}' } }] });
    finish('tool_calls', usage(1800, 60, 0.0021));
    return;
  }
  finish('stop', usage(1200, 30, 0.0017));
}).listen(0, '127.0.0.1', function listening() {
  const { port } = this.address();
  if (process.argv[2]) writeFileSync(process.argv[2], String(port));
  console.log(port);
});
