#!/usr/bin/env node
/* A stand-in for Grok Build that replays one recorded turn, for the TUI
 * end-to-end check. Everything a real `grok` is asked by ClikCode is
 * answered: --version, --help, models, login/logout, and a turn.
 *
 * The turn is the shape that used to flash and vanish: text, a tool call,
 * more text, then a `result` record carrying ONLY the last text block --
 * which is what Claude-shaped CLIs really report there. Streamed the way
 * `--include-partial-messages` streams: content_block deltas AND the
 * completed assistant message for each block. */
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (process.env.FAKE_LOG) (await import('node:fs')).appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(argv)}\n`);
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// FAKE_TURNS is a list, one entry per turn: the Nth invocation replays the
// Nth, counted in FAKE_STATE so consecutive turns can say different things.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const turns = JSON.parse(process.env.FAKE_TURNS ?? 'null') ?? [
  { blocks: ['Checking the workspace first.', 'The final commit is live.'] },
];
const nextTurn = () => {
  const counter = process.env.FAKE_STATE;
  let index = 0;
  if (counter) {
    index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
    writeFileSync(counter, String(index + 1));
  }
  return turns[Math.min(index, turns.length - 1)];
};

if (argv.includes('--version')) { console.log('grok 9.9.9 (fake)'); process.exit(0); }
if (argv.includes('--help')) { console.log('Usage: grok [options]\n  --reasoning-effort <EFFORT>  Reasoning effort'); process.exit(0); }
if (argv[0] === 'models' || argv.includes('--list-models')) { console.log('grok-4\ngrok-4-fast'); process.exit(0); }
if (['login', 'logout', 'auth', 'status'].includes(argv[0])) process.exit(0);

// `grok agent stdio`: the ACP agent ClikCode starts for Grok since it moved
// to ACP. Same recorded turns, as session/update notifications.
if (argv[0] === 'agent' && argv.includes('stdio')) {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const models = { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'Grok 4' }, { modelId: 'grok-4-fast', name: 'Grok 4 Fast' }] };
  let sessionId;
  let cancelled = false;
  const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
  const prompt = async (id) => {
    const turn = nextTurn();
    cancelled = false;
    const tool = async (toolCallId, command, result, ms) => {
      update({ sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'in_progress', rawInput: { command } });
      await sleep(ms);
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: result } }] });
    };
    for (let index = 0; index < (turn.tools_first ?? 0) && !cancelled; index += 1) {
      await tool(`lead_${index}`, `npx vitest run part${index}`, `part${index} ok`, Number(process.env.FAKE_TOOL_MS ?? 600));
    }
    // `streamed_tool`: a command printing a line at a time while it runs, then
    // completing with no content -- how ACP agents report a long build.
    if (turn.streamed_tool) {
      const { lines, ms } = turn.streamed_tool;
      update({ sessionUpdate: 'tool_call', toolCallId: 'stream_1', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
      let printed = '';
      for (const line of lines) {
        await sleep(ms);
        printed += `${line}\n`;
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'stream_1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: printed } }] });
      }
      await sleep(ms);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'stream_1', status: 'completed' });
    }
    for (const [index, block] of turn.blocks.entries()) {
      for (const piece of block.match(/\S+\s*/g) ?? []) {
        if (cancelled) break;
        await sleep(Number(process.env.FAKE_DELAY_MS ?? 120));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
      }
      if (index < turn.blocks.length - 1 && !cancelled) await tool(`tool_${index}`, 'git log -1 --oneline', 'abc123 fix', 600);
    }
    await sleep(300);
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
  };
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const { id, method, params } = message;
      if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [] } });
      else if (method === 'session/new') { sessionId = randomUUID(); send({ id, result: { sessionId, models } }); }
      else if (method === 'session/load' || method === 'session/resume') { sessionId = params.sessionId; send({ id, result: { models } }); }
      else if (method === 'session/set_model') { models.currentModelId = params.modelId; send({ id, result: {} }); }
      else if (method === 'session/set_mode' || method === 'session/set_config_option') send({ id, result: {} });
      else if (method === 'session/prompt') void prompt(id);
      else if (method === 'session/cancel') cancelled = true;
      else if (id !== undefined) send({ id, error: { code: -32601, message: `fake grok: ${method}` } });
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
const turn = nextTurn();

const at = argv.indexOf('--session-id');
const resume = argv.indexOf('--resume');
const sessionId = at >= 0 ? argv[at + 1] : resume >= 0 ? argv[resume + 1] : randomUUID();
// A real vendor reports the model it actually ran.
const modelAt = argv.indexOf('--model');
out({ type: 'system', subtype: 'init', session_id: sessionId, model: modelAt >= 0 ? argv[modelAt + 1] : 'grok-4' });

const streamBlock = async (index, text) => {
  out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    await sleep(Number(process.env.FAKE_DELAY_MS ?? 120));
    out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
};

// FAKE_FAMILY=generic speaks the shape the generic-json reader handles --
// whole assistant messages, a tool lifecycle, a final result -- the way
// Command Code and the other generic-json harnesses do.
const generic = process.env.FAKE_FAMILY === 'generic';
if (generic) {
  for (const [index, block] of turn.blocks.entries()) {
    await sleep(400);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: block }] } });
    if (index < turn.blocks.length - 1) {
      out({ type: 'event', event: { type: 'tool_running', toolCallId: `t${index}`, toolName: 'shell', description: 'git log -1 --oneline' } });
      await sleep(600);
      out({ type: 'event', event: { type: 'tool_completed', toolCallId: `t${index}`, toolName: 'shell', result: [{ type: 'text', text: 'abc123 fix' }] } });
    }
  }
  await sleep(300);
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: turn.blocks[turn.blocks.length - 1] });
  process.exit(0);
}

// `tools_first`: that many tool calls before any text -- a long agentic turn
// whose journal holds only activities, which folds to "Interrupted turn
// activity: ..." wherever it is drawn as if it had ended.
for (let index = 0; index < (turn.tools_first ?? 0); index += 1) {
  const id = `lead_${index}`;
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `npx vitest run part${index}` } }] } });
  await sleep(Number(process.env.FAKE_TOOL_MS ?? 600));
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `part${index} ok` }] } });
  // Reported again mid-turn, as a real CLI does: the worker then pushes a
  // snapshot whose journal already holds these calls.
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: modelAt >= 0 ? argv[modelAt + 1] : 'grok-4' });
}

for (const [index, block] of turn.blocks.entries()) {
  await streamBlock(index * 2, block);
  if (index < turn.blocks.length - 1) {
    const id = `tool_${index}`;
    out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git log -1 --oneline' } }] } });
    await sleep(600);
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'abc123 fix' }] } });
  }
}
await sleep(300);
out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: turn.blocks[turn.blocks.length - 1] });
}
