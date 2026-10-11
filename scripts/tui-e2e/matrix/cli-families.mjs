/* The one-shot CLI wire families: what a structured or text CLI writes to
 * stdout for the scripted turn (turn-script.mjs). Each shape is one the
 * adapters read, taken from their own fixtures -- never invented here:
 *   claude-stream-json   src/harness/protocol/turn-flow-conformance.vitest.test.ts
 *                        (claudeStreamJson), scripts/tui-e2e/fake-grok.mjs
 *   pi-json              same file (piJson)
 *   antigravity          same file (antigravityJson), events/adapters.ts
 *   generic (OpenClaw)   src/harness/protocol/turn-usage-vendors.vitest.test.ts
 *   aider / text         events/aider.ts, same conformance file
 * The wire families that only an ACP harness reaches (opencode, goose, cline,
 * cursor) are not played here: those harnesses' primary transport is ACP. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export async function runCli({ harness, turn, argv, log, sleep, wordMs, promptMatch }) {
  const sessionId = randomUUID();
  const out = (record) => { log({ ev: 'emit', rec: record }); process.stdout.write(`${JSON.stringify(record)}\n`); };
  const line = (text) => { log({ ev: 'emit', text }); process.stdout.write(`${text}\n`); };

  // The prompt: argv, or stdin for a harness whose turn pipes it.
  let said = argv.join(' ');
  if (harness.turn?.promptInput === 'stdin') {
    said = await new Promise((resolve) => {
      let seen = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { seen += chunk; if (!promptMatch || seen.includes(promptMatch)) resolve(seen); });
      process.stdin.on('end', () => resolve(seen));
    });
  }
  // Only the turn the rig typed plays the script. Everything else ClikCode runs
  // of this binary (a usage probe `-p /usage`, `mcp add`, a title) is a side
  // invocation: logged, answered with nothing, never given the markers.
  const matched = !promptMatch || said.includes(promptMatch);
  log({ ev: 'recv', what: harness.turn?.promptInput === 'stdin' ? 'stdin' : 'argv', matched });
  if (!matched) { log({ ev: 'end' }); return; }

  const ops = turn.ops;
  const family = harness.parser;
  const wordsOf = (text) => text.match(/\s*\S+\s*|\s+$/g) ?? [];
  let usage;
  let lastText = '';
  let n = 0;

  if (family === 'claude-stream-json') {
    out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model-1' });
    const parents = new Map();
    for (const op of ops) {
      switch (op.op) {
        case 'text': {
          const index = n++;
          out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
          for (const piece of wordsOf(op.text)) {
            await sleep(wordMs);
            out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
          }
          out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${index}`, role: 'assistant', content: [{ type: 'text', text: op.text }] } });
          lastText = op.text;
          break;
        }
        case 'thought':
          out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${n++}`, role: 'assistant', content: [{ type: 'thinking', thinking: `**${op.heading}**\n\n${op.text}` }] } });
          break;
        case 'sleep': await sleep(op.ms); break;
        case 'tool-start':
          out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${n++}`, role: 'assistant', content: [{ type: 'tool_use', id: op.id, name: 'Bash', input: { command: op.title.replace(/^echo /, 'echo ') } }] } });
          break;
        case 'tool-end':
          out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: op.id, content: op.result ?? 'ok' }] } });
          break;
        case 'agent-start':
          out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${n++}`, role: 'assistant', content: [{ type: 'tool_use', id: op.id, name: 'Task', input: { description: op.description, subagent_type: 'Explore' } }] } });
          break;
        case 'child-start':
          parents.set(op.id, op.parent);
          out({ type: 'assistant', session_id: sessionId, parent_tool_use_id: op.parent, message: { id: `msg_${n++}`, role: 'assistant', content: [{ type: 'tool_use', id: op.id, name: 'Read', input: { file_path: `/tmp/${op.title.split(' ').pop()}` } }] } });
          break;
        case 'child-end':
          out({ type: 'user', session_id: sessionId, parent_tool_use_id: op.parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: op.id, content: op.result ?? 'ok' }] } });
          break;
        case 'agent-end':
          out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: op.id, content: op.result ?? 'done' }] },
            tool_use_result: { totalToolUseCount: 2, totalTokens: 900, totalDurationMs: 1200 } });
          break;
        case 'plan': {
          const id = `todo_${n++}`;
          out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${n++}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'TodoWrite',
            input: { todos: op.entries.map((entry) => ({ content: entry.content, status: entry.status, activeForm: entry.content })) } }] } });
          out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
          break;
        }
        case 'usage': usage = op; break;
        default: throw new Error(`fake ${family}: unknown op ${op.op}`);
      }
    }
    await sleep(100);
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: lastText,
      ...(usage ? { total_cost_usd: 0.01, usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}) });
  } else if (family === 'pi-json') {
    let index = 0;
    for (const op of ops) {
      switch (op.op) {
        case 'text':
          for (const piece of wordsOf(op.text)) {
            await sleep(wordMs);
            out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta: piece } });
          }
          index += 1;
          break;
        case 'thought': {
          out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: index, partial: { content: [{ type: 'thinking', thinking: '' }] } } });
          let so = '';
          for (const piece of wordsOf(`**${op.heading}**\n\n${op.text}`)) {
            await sleep(op.ms ?? 20);
            so += piece;
            out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: index, delta: piece, partial: { content: [{ type: 'thinking', thinking: so }] } } });
          }
          index += 1;
          break;
        }
        case 'sleep': await sleep(op.ms); break;
        case 'tool-start': out({ type: 'tool_execution_start', toolCallId: op.id, toolName: 'bash', args: { command: op.title } }); break;
        case 'tool-end': out({ type: 'tool_execution_end', toolCallId: op.id, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: op.result ?? 'ok' }] } }); break;
        case 'usage': usage = op; break;
        default: throw new Error(`fake ${family}: unknown op ${op.op}`);
      }
    }
    out({ type: 'message_end', message: { role: 'assistant', ...(usage ? { usage: { input: usage.input, output: usage.output, totalTokens: usage.input + usage.output, cost: { total: 0.001 } } } : {}) } });
  } else if (family === 'antigravity') {
    let step = 0;
    const steps = new Map();
    for (const op of ops) {
      switch (op.op) {
        case 'text':
          for (const piece of wordsOf(op.text)) {
            await sleep(wordMs);
            out({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 100, state: 'ACTIVE', text_delta: piece } });
          }
          lastText = op.text;
          break;
        case 'sleep': await sleep(op.ms); break;
        case 'tool-start': {
          const index = ++step;
          steps.set(op.id, index);
          out({ event: 'step_update', step_update: { step_type: 'tool', step_index: index, state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: op.title } } } });
          steps.set(`${op.id}:t`, op.title);
          break;
        }
        case 'tool-end':
          out({ event: 'step_update', step_update: { step_type: 'tool', step_index: steps.get(op.id), state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: steps.get(`${op.id}:t`) } } } });
          break;
        case 'usage': usage = op; break;
        default: throw new Error(`fake ${family}: unknown op ${op.op}`);
      }
    }
    out({ event: 'result', result: { status: 'SUCCESS', response: lastText, ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}) } });
  } else if (harness.turn?.output === 'json') {
    // OpenClaw `agent --local --json`: one document at the end.
    for (const op of ops) {
      if (op.op === 'text') lastText = op.text;
      if (op.op === 'usage') usage = op;
      if (op.op === 'sleep') await sleep(op.ms);
    }
    process.stdout.write(`${JSON.stringify({
      payloads: [{ text: lastText }],
      meta: {
        durationMs: 100, finalAssistantVisibleText: lastText,
        agentMeta: { sessionId, provider: 'fake', model: 'fake-model-1', contextTokens: usage?.size ?? 0, promptTokens: usage?.input ?? 0,
          ...(usage ? { usage: { input: usage.input, output: usage.output, total: usage.input + usage.output }, costUsd: 0.001 } : {}) },
      },
    })}\n`);
    log({ ev: 'emit', text: lastText });
  } else if (family === 'aider') {
    // `--chat-history-file <path>`: the reply kept is the one in that file.
    const historyAt = argv.indexOf('--chat-history-file');
    for (const text of ['Aider v0.86.0', 'Main model: fake-model-1 with diff edit format', 'Git repo: none']) line(text);
    const reply = [];
    for (const op of ops) {
      if (op.op === 'text') { line(op.text); reply.push(op.text); }
      if (op.op === 'sleep') await sleep(op.ms);
      if (op.op === 'usage') usage = op;
    }
    if (usage) line('Tokens: 4.0k sent, 321 received.');
    if (historyAt >= 0 && argv[historyAt + 1]) {
      mkdirSync(dirname(argv[historyAt + 1]), { recursive: true });
      writeFileSync(argv[historyAt + 1], `#### the matrix turn\n\n${reply.join('\n')}\n`);
    }
  } else {
    // A text-only CLI (Continue `cn`): the answer, a line at a time.
    for (const op of ops) {
      if (op.op === 'text') { await sleep(wordMs); line(op.text); }
      if (op.op === 'sleep') await sleep(op.ms);
    }
  }
  log({ ev: 'end' });
}
