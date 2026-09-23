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
if (argv[0] === 'models') { console.log('grok-4\ngrok-4-fast'); process.exit(0); }
if (argv[0] === 'login' || argv[0] === 'logout' || (argv[0] === 'auth')) process.exit(0);
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
