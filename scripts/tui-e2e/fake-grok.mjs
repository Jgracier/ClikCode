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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
// The matrix rig (matrix/fake-vendor.mjs) reuses this ACP agent for every
// harness that rides the shared ACP client. FAKE_EMIT_LOG: every update is
// logged with Date.now() at the moment it is written to the pipe, and the
// prompt's arrival too. FAKE_ACP_PROFILE: what the catalog entry says this
// vendor's agent offers (models, modes, config options, how a sub-agent's
// calls name their parent). Both are off unless set.
const emitLog = process.env.FAKE_EMIT_LOG;
const logEmit = (record) => { if (emitLog) appendFileSync(emitLog, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...record })}\n`); };
const profile = JSON.parse(process.env.FAKE_ACP_PROFILE ?? 'null') ?? {};
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
// Sign-in as the real `grok login` does it: a device link and code, then a
// wait for the browser (here, two seconds), then success. Like the real one
// it insists on a TTY.
if (argv[0] === 'login') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log('not a tty'); process.exit(9); }
  // FAKE_LOGIN_KEY: a sign-in that asks for a key on its own prompt line, as
  // Hermes's does, and succeeds only with that key.
  if (process.env.FAKE_LOGIN_KEY) {
    process.stdin.setEncoding('utf8');
    let buffered = '';
    process.stdin.on('data', (chunk) => { buffered += chunk; });
    const line = async () => {
      while (!/[\r\n]/.test(buffered)) await new Promise((resolve) => setTimeout(resolve, 20));
      const [typed, ...rest] = buffered.split(/\r\n?|\n/);
      buffered = rest.join('\n');
      return typed.trim();
    };
    process.stdout.write('Paste your API key: ');
    const typed = await line();
    process.stdout.write('\n');
    // FAKE_LOGIN_DEFAULT: then a question with a shown default, as Hermes's
    // `Base URL [...]:`, that Enter alone must answer.
    if (process.env.FAKE_LOGIN_DEFAULT) {
      process.stdout.write('Base URL [https://api.example.test/v1]: ');
      const base = await line();
      process.stdout.write('\n');
      if (base) process.exit(5);
    }
    process.exit(typed === process.env.FAKE_LOGIN_KEY ? 0 : 4);
  }
  console.log('To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=AB12-CD34\nConfirm this code in your browser:\n  AB12-CD34\nWaiting for authorization...');
  // FAKE_LOGIN_HOLD: while that file exists (up to 30s) the browser has not
  // answered yet, so a test can cancel the wait.
  const started = Date.now();
  const hold = process.env.FAKE_LOGIN_HOLD;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  while (hold && existsSync(hold) && Date.now() - started < 30_000) await new Promise((resolve) => setTimeout(resolve, 100));
  // Awaited, never a timer: everything below is the agent, and a login that
  // fell through into it used up the scenario's first answer.
  process.exit(0);
} else if (['logout', 'auth', 'status'].includes(argv[0])) process.exit(0);
// `grok mcp add <name> <command> [args...]`, as the real one records it, so
// the next turn finds the server there and does not add it again. Never a
// turn: falling through used up the scenario's answers.
if (argv[0] === 'mcp') {
  if (argv[1] === 'add' && argv[2] && process.env.HOME) {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${process.env.HOME}/.grok`, { recursive: true });
    appendFileSync(`${process.env.HOME}/.grok/config.toml`, `\n[mcp_servers.${JSON.stringify(argv[2])}]\ncommand = ${JSON.stringify(argv[3] ?? '')}\nargs = ${JSON.stringify(argv.slice(4))}\n`);
  }
  process.exit(0);
}

// `grok agent stdio`: the ACP agent ClikCode starts for Grok since it moved
// to ACP. Same recorded turns, as session/update notifications.
if ((argv[0] === 'agent' && argv.includes('stdio')) || argv.includes('--acp')) {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const models = 'models' in profile ? profile.models : { currentModelId: 'grok-4', availableModels: [{ modelId: 'grok-4', name: 'Grok 4' }, { modelId: 'grok-4-fast', name: 'Grok 4 Fast' }] };
  // What session/new and session/load answer with, as the catalog entry's
  // vendor shapes it: `models`, `modes` (a modes object) and/or config options.
  const sessionShape = () => ({
    ...(models ? { models } : {}),
    ...(profile.modes ? { modes: profile.modes } : {}),
    ...(profile.configOptions ? { configOptions: profile.configOptions } : {}),
  });
  let sessionId;
  let cancelled = false;
  // FAKE_STEERING: advertise `_session/steering` the way claude-agent-acp
  // 0.84 does, and behave as it does -- a steer injected while a call is open
  // interrupts that call. What was steered in is answered before the turn ends.
  const steering = process.env.FAKE_STEERING === '1';
  const open = new Set();
  let running = false;
  let steered = [];
  // Requests this agent made of the client (permissions), by id.
  const asked = new Map();
  let askedCount = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const id = `fake_${++askedCount}`;
    asked.set(id, resolve);
    send({ id, method, params });
  });
  const update = (value, onSession = sessionId) => {
    logEmit({ ev: 'update', update: value });
    send({ method: 'session/update', params: { sessionId: onSession, update: value } });
  };
  const prompt = async (id, params) => {
    // What was sent, for `{received}`: whether a long paste reached it whole.
    const said = (params?.prompt ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('\n');
    // The matrix rig plays its script only for the prompt it typed; any other
    // prompt ClikCode sends on its own (a title, a probe) just gets an answer.
    const matched = !profile.promptMatch || said.includes(profile.promptMatch);
    logEmit({ ev: 'recv', what: 'session/prompt', matched });
    const received = /pasted row 1\n[\s\S]*pasted row 12/.test(said) && !said.includes('[Pasted text') ? 'whole' : 'missing';
    const turn = matched ? nextTurn() : { blocks: ['ok'] };
    cancelled = false;
    // `refuse`: the vendor turns the prompt away with this message (a quota
    // refusal, say), as an error answer to session/prompt.
    if (turn.refuse) { send({ id, error: { code: -32603, message: turn.refuse } }); return; }
    running = true;
    steered = [];
    const tool = async (toolCallId, command, result, ms) => {
      open.add(toolCallId);
      update({ sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'in_progress', rawInput: { command } });
      await sleep(ms);
      if (!open.delete(toolCallId)) return; // interrupted by a steer
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: result } }] });
    };
    // `thought`: reasoning before anything else, a word at a time, then a
    // pause with nothing arriving -- long enough to read the status line.
    if (turn.thought) {
      for (const piece of turn.thought.text.match(/\S+\s*/g) ?? []) {
        await sleep(40);
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
      }
      await sleep(turn.thought.ms ?? 1500);
    }
    // `permissions`: commands that need the user's approval, all asked at
    // once (as parallel calls are); `{answers}` in a block is what came back.
    let answers = '';
    if (turn.permissions && !cancelled) {
      const outcomes = await Promise.all(turn.permissions.map((command, index) => ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: `perm_${index}`, title: command, kind: 'execute', rawInput: { command } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      })));
      answers = outcomes.map((result) => result?.outcome?.optionId ?? result?.outcome?.outcome ?? 'none').join(', ');
    }
    // `explore`: reads and searches in a row, each with what it found.
    for (const [index, call] of (turn.explore ?? []).entries()) {
      if (cancelled) break;
      const toolCallId = `explore_${index}`;
      update({ sessionUpdate: 'tool_call', toolCallId, title: call.title, kind: call.kind, status: 'in_progress', rawInput: call.input ?? {} });
      await sleep(call.ms ?? 500);
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: call.result } }] });
    }
    // `long_command`: a command whose whole output arrives with its end.
    if (turn.long_command && !cancelled) {
      const { lines, ms } = turn.long_command;
      update({ sessionUpdate: 'tool_call', toolCallId: 'long_1', title: 'npm run build', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm run build' } });
      await sleep(ms ?? 800);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'long_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }] });
    }
    // `intro`: a paragraph before any call, so a turn's prose and its calls
    // alternate the way a real agent's do.
    if (turn.intro && !cancelled) {
      for (const piece of turn.intro.match(/\S+\s*/g) ?? []) {
        await sleep(Number(process.env.FAKE_DELAY_MS ?? 120));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n' } });
    }
    for (let index = 0; index < (turn.tools_first ?? 0) && !cancelled; index += 1) {
      await tool(`lead_${index}`, `npx vitest run part${index}`, `part${index} ok`, Number(process.env.FAKE_TOOL_MS ?? 600));
    }
    // `subagents`: { count, calls, hold_ms } -- Agent tool calls left
    // running, each with `calls` child tool calls stamped with its id the way
    // claude-agent-acp stamps a sub-agent's (_meta.claudeCode.parentToolUseId),
    // held open for hold_ms, then finished.
    if (turn.subagents && !cancelled) {
      const { count, calls, hold_ms: hold } = turn.subagents;
      for (let agent = 0; agent < count; agent += 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: `agent_${agent}`, title: `Task: worker ${agent}`, kind: 'think', status: 'in_progress', rawInput: { description: `worker ${agent}`, subagent_type: 'general-purpose' } });
      }
      for (let call = 0; call < calls && !cancelled; call += 1) {
        for (let agent = 0; agent < count; agent += 1) {
          const id = `agent_${agent}_call_${call}`;
          const meta = { claudeCode: { parentToolUseId: `agent_${agent}` } };
          update({ sessionUpdate: 'tool_call', toolCallId: id, title: `Read file${call}.ts`, kind: 'read', status: 'in_progress', rawInput: { file_path: `/tmp/file${call}.ts` }, _meta: meta });
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }], _meta: meta });
        }
        await sleep(40);
      }
      await sleep(hold ?? 0);
      for (let agent = 0; agent < count; agent += 1) {
        update({ sessionUpdate: 'tool_call_update', toolCallId: `agent_${agent}`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `worker ${agent} done` } }] });
      }
    }
    // `hold_ms`: one more call that runs that long with nothing new arriving,
    // so a test can look at a running turn whose screen holds still.
    if (turn.hold_ms && !cancelled) await tool('hold_1', 'sleep 30', 'held call done', turn.hold_ms);
    // `edits`: files the turn edits in its working directory, each written
    // from `old` to `new` and reported as an ACP diff, as an edit tool does.
    for (const [index, edit] of (turn.edits ?? []).entries()) {
      if (cancelled) break;
      const { writeFileSync: write } = await import('node:fs');
      write(edit.path, edit.old);
      update({ sessionUpdate: 'tool_call', toolCallId: `edit_${index}`, title: `Edit ${edit.path}`, kind: 'edit', status: 'in_progress', rawInput: { path: edit.path } });
      await sleep(200);
      write(edit.path, edit.new);
      update({ sessionUpdate: 'tool_call_update', toolCallId: `edit_${index}`, status: 'completed', content: [{ type: 'diff', path: edit.path, oldText: edit.old, newText: edit.new }] });
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
    // `emits`: a script, an event list played in order -- the way to write a
    // turn whose ORDER matters (parallel calls, a child begun after text, a
    // steer between two calls) which the fixed shapes above cannot say.
    //   { op: 'text', text, ms? }            words, `ms` apart (FAKE_DELAY_MS)
    //   { op: 'thought', heading?, text, ms? }  reasoning, **heading** first
    //   { op: 'sleep', ms }                  nothing arrives
    //   { op: 'tool-start', id, title, kind?, input?, parent? }
    //   { op: 'tool-end', id, result?, status?, parent? }
    //   { op: 'tool', id, title, ms, result? }  start, hold `ms`, end
    //   { op: 'agent-start', id, title, description? } / { op: 'agent-end', id, result? }
    //   { op: 'child-start', id, parent, title, kind?, input? } / { op: 'child-end', id, parent, result? }
    //   { op: 'permission', id, command, result? }  asks; allowed -> done, else failed
    //   { op: 'usage', used, size, cost? }   { op: 'plan', entries: [{content, status}] }
    //   { op: 'background', tasks: [{ type, description?, parent? }] }  the vendor's whole live
    //     background-task level (claude-agent-acp's `_claude/sdkMessage` background_tasks_changed;
    //     type is a task_type: local_agent, local_bash, local_workflow). `tasks: []` empties it.
    // A steer injected while the script runs is answered at the end, as above.
    const words = async (text, ms) => {
      // Leading blanks stay with the first word: a script continues a sentence.
      for (const piece of text.match(/\s*\S+\s*|\s+$/g) ?? []) {
        if (cancelled) return;
        await sleep(ms ?? Number(process.env.FAKE_DELAY_MS ?? 120));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
      }
    };
    // How this vendor's agent says "this call belongs to that sub-agent":
    // claude-agent-acp stamps `_meta.claudeCode.parentToolUseId`, Qwen Code
    // `_meta.parentToolCallId` (+ subagentType); cursor-agent runs the child in
    // a session of its own, announced by `subagent_spawned` (see childSession).
    const shape = profile.parentShape ?? 'claude';
    const metaFor = (parent) => {
      if (!parent || shape === 'cursor') return {};
      return shape === 'qwen' ? { _meta: { parentToolCallId: parent, subagentType: 'explore' } } : { _meta: { claudeCode: { parentToolUseId: parent } } };
    };
    const childSession = () => (shape === 'cursor' ? `${sessionId}.1` : sessionId);
    const done = (id, result, status, parent) => update({
      sessionUpdate: 'tool_call_update', toolCallId: id, status: status ?? 'completed',
      ...(result === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: result } }] }), ...metaFor(parent),
    });
    for (const event of turn.emits ?? []) {
      if (cancelled) break;
      switch (event.op) {
        case 'text': await words(event.text, event.ms); break;
        case 'thought': {
          const body = `${event.heading ? `**${event.heading}**\n\n` : ''}${event.text ?? ''}`;
          for (const piece of body.match(/\S+\s*/g) ?? []) {
            await sleep(event.ms ?? 40);
            update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
          }
          break;
        }
        case 'sleep': await sleep(event.ms); break;
        case 'tool-start':
          open.add(event.id);
          update({ sessionUpdate: 'tool_call', toolCallId: event.id, title: event.title, kind: event.kind ?? 'execute', status: 'in_progress',
            rawInput: event.input ?? { command: event.title }, ...metaFor(event.parent) });
          break;
        case 'tool-end': if (open.delete(event.id) || event.parent) done(event.id, event.result, event.status, event.parent); break;
        case 'tool': await tool(event.id, event.title, event.result ?? 'ok', event.ms); break;
        case 'agent-start':
          open.add(event.id);
          update({ sessionUpdate: 'tool_call', toolCallId: event.id, title: event.title, kind: 'think', status: 'in_progress',
            rawInput: { description: event.description ?? event.title, subagent_type: 'general-purpose' } });
          if (shape === 'cursor') update({ sessionUpdate: 'subagent_spawned', subagentSessionId: childSession(), name: 'explore', task: event.title, capabilities: {}, _meta: { cursor: { toolCallId: event.id, agentId: 'a1' } } });
          break;
        case 'agent-end': if (open.delete(event.id)) done(event.id, event.result ?? 'agent done'); break;
        case 'child-start':
          update({ sessionUpdate: 'tool_call', toolCallId: event.id, title: event.title, kind: event.kind ?? 'read', status: 'in_progress',
            rawInput: event.input ?? { file_path: `/tmp/${event.title.split(' ').pop()}` }, ...metaFor(event.parent) }, event.parent ? childSession() : sessionId);
          break;
        case 'child-end':
          update({ sessionUpdate: 'tool_call_update', toolCallId: event.id, status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: event.result ?? 'ok' } }], ...metaFor(event.parent) }, event.parent ? childSession() : sessionId);
          break;
        case 'permission': {
          open.add(event.id);
          update({ sessionUpdate: 'tool_call', toolCallId: event.id, title: event.command, kind: 'execute', status: 'pending', rawInput: { command: event.command } });
          const outcome = await ask('session/request_permission', {
            sessionId,
            toolCall: { toolCallId: event.id, title: event.command, kind: 'execute', rawInput: { command: event.command } },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          });
          const allowed = outcome?.outcome?.optionId === 'allow';
          answers += `${answers ? ', ' : ''}${outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? 'none'}`;
          if (open.delete(event.id)) done(event.id, allowed ? (event.result ?? 'ran') : '[rejected by user]', allowed ? 'completed' : 'failed');
          break;
        }
        case 'usage': update({ sessionUpdate: 'usage_update', used: event.used, size: event.size, ...(event.cost ? { cost: { amount: event.cost, currency: 'USD' } } : {}) }); break;
        case 'background':
          send({ method: '_claude/sdkMessage', params: { sessionId, message: { type: 'system', subtype: 'background_tasks_changed',
            tasks: (event.tasks ?? []).map((task, index) => ({ task_id: `bg${index}`, task_type: task.type, description: task.description ?? task.type,
              ...(task.parent ? { parent_task_id: task.parent } : {}) })) } } });
          break;
        case 'plan': update({ sessionUpdate: 'plan', entries: event.entries.map((entry) => ({ priority: 'medium', ...entry })) }); break;
        default: throw new Error(`fake grok: unknown emit ${event.op}`);
      }
    }
    for (const [index, block] of (turn.blocks ?? []).map((text) => text.replace('{answers}', answers).replace('{received}', received)).entries()) {
      for (const piece of block.match(/\S+\s*/g) ?? []) {
        if (cancelled) break;
        await sleep(Number(process.env.FAKE_DELAY_MS ?? 120));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
      }
      if (index < (turn.blocks ?? []).length - 1 && !cancelled) await tool(`tool_${index}`, 'git log -1 --oneline', 'abc123 fix', 600);
    }
    for (const text of steered.splice(0)) {
      for (const piece of `Steered in: ${text}.`.match(/\S+\s*/g) ?? []) {
        await sleep(Number(process.env.FAKE_DELAY_MS ?? 120));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
      }
    }
    await sleep(300);
    running = false;
    logEmit({ ev: 'end' });
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn', ...(profile.promptUsage ? { usage: profile.promptUsage } : {}) } });
    // `after`: what the vendor says once the turn is answered -- a background
    // task it left running ending ({ op: 'sleep' } and { op: 'background' }).
    for (const event of turn.after ?? []) {
      if (event.op === 'sleep') await sleep(event.ms);
      else if (event.op === 'background') {
        send({ method: '_claude/sdkMessage', params: { sessionId, message: { type: 'system', subtype: 'background_tasks_changed',
          tasks: (event.tasks ?? []).map((task, index) => ({ task_id: `bg${index}`, task_type: task.type, description: task.description ?? task.type })) } } });
      }
    }
  };
  const steer = (id, params) => {
    if (!running && params?._meta?.steering?.idleBehavior === 'promptRequired') { send({ id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } }); return; }
    for (const toolCallId of open) {
      open.delete(toolCallId);
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '[Request interrupted by user for tool use]' } }] });
    }
    steered.push((params?.prompt ?? []).map((part) => part?.text ?? '').join(''));
    send({ id, result: { outcome: 'injected' } });
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
      if (!method && asked.has(id)) { asked.get(id)(message.result); asked.delete(id); }
      else if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, ...(profile.agentCapabilities ?? {}) }, authMethods: [], ...(steering ? { _meta: { steering: { supported: true } } } : {}) } });
      else if (method === '_session/steering' && steering) steer(id, params);
      else if (method === 'session/new') { sessionId = randomUUID(); send({ id, result: { sessionId, ...sessionShape() } }); }
      else if (method === 'session/load' || method === 'session/resume') { sessionId = params.sessionId; send({ id, result: sessionShape() }); }
      else if (method === 'session/set_model') { if (models) models.currentModelId = params.modelId; send({ id, result: {} }); }
      else if (method === 'session/set_mode') { if (profile.modes) profile.modes.currentModeId = params.modeId; send({ id, result: {} }); }
      else if (method === 'session/set_config_option') {
        // As agents answer it: the option list as it now stands.
        const option = (profile.configOptions ?? []).find((item) => (item.id ?? item.configId) === params.configId);
        if (option) option.currentValue = params.value;
        send({ id, result: profile.configOptions ? { configOptions: profile.configOptions } : {} });
      }
      else if (method === 'session/prompt') void prompt(id, params);
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
