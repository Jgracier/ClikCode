/** The turn-flow standard's adapter half (docs/TURN_FLOW_STANDARD.md sections
 * 2, 4, 5, 12), enforced.
 *
 * One recorded-or-crafted fixture per parser FAMILY runs through the real
 * adapter (the structured-CLI line reader, the Codex app-server client, the
 * ACP client); what it emits is held to the rules every harness owes, and the
 * set of things it produced (children, thoughts, plan, usage, tool output)
 * must be exactly what the family is declared to supply. Then every harness
 * in the catalog is held to the family its primary transport reaches:
 *
 *   - a family with a parser of its own (Claude stream-json, Pi, Antigravity,
 *     Aider, Codex): the harness's declared `capabilities` must EQUAL what the
 *     fixture produced -- nothing it could not show, nothing it hides;
 *   - a family whose agents differ by vendor (ACP, generic JSON): the declared
 *     `capabilities` may not claim more than the adapter can produce. A
 *     vendor that publishes less says so with `false`.
 *
 * Fixtures are crafted from the shapes each vendor's own source/protocol
 * defines (cited per fixture); they are not live runs (AGENTS.md: never test
 * against a real vendor).
 *
 * Failure messages name the harness (or family) and the rule. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import type { AiHarnessFlowCapabilities, AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { HarnessTurnObserver } from '../events/turn-observer.js';
import { createStreamState } from '../events/adapters.js';
import { reportStructuredLine } from '../events/structured.js';
import { createAcpSession } from '../transport/acp-client.js';
import { createCodexSession } from '../transport/codex-app-server.js';
import { harnessTurnTransport } from '../transport/select.js';
import { upsertActivityEvent } from '../../tui/render/activity-log.js';

type Json = Record<string, unknown>;
type Capability = keyof AiHarnessFlowCapabilities;
const CAPABILITIES: readonly Capability[] = ['childActivity', 'thinking', 'plan', 'usage', 'toolOutput'];

interface Observed { events: HarnessActivityEvent[]; plans: number; usage: boolean; notices: string[] }
interface Fixture {
  /** What the fixture is, and where its shapes come from. */
  name: string;
  run: () => Promise<Observed>;
  /** What this family supplies from this fixture, stated once, here. */
  expected: AiHarnessFlowCapabilities;
  /** The row ids the fixture's children hang under, when it has children. */
  parents?: readonly string[];
  /** Thoughts the fixture streams: id -> frames, so a stable id is checked. */
  thoughtFrames?: Readonly<Record<string, number>>;
}

const caps = (childActivity: boolean, thinking: boolean, plan: boolean, usage: boolean, toolOutput: boolean): AiHarnessFlowCapabilities =>
  ({ childActivity, thinking, plan, usage, toolOutput });

// ---------------------------------------------------------------- runners

function recorder(): { observed: Observed; observer: HarnessTurnObserver } {
  const observed: Observed = { events: [], plans: 0, usage: false, notices: [] };
  return {
    observed,
    observer: {
      onActivity: (event) => { observed.events.push(event); },
      onPlan: () => { observed.plans += 1; },
      onUsage: (usage) => { if (usage.input || usage.output || usage.totalTokens || usage.costUsd || usage.contextUsed) observed.usage = true; },
      onNotice: (notice) => { observed.notices.push(notice); },
    },
  };
}

/** A structured CLI's stdout lines through the real line reader. */
function cliFixture(
  name: string, harness: Partial<AiLocalHarnessDefinition> & { command: string; parser: string },
  records: Array<Json | string>, extra: Omit<Fixture, 'name' | 'run'>,
): Fixture {
  return {
    name, ...extra,
    run: async () => {
      const { observed, observer } = recorder();
      const state = createStreamState();
      const definition = { turn: { output: 'json-lines' }, ...harness } as unknown as AiLocalHarnessDefinition;
      for (const record of records) reportStructuredLine(definition, typeof record === 'string' ? record : JSON.stringify(record), observer, state);
      return observed;
    },
  };
}

/** The Codex app-server client against a fake server speaking its JSONL. */
function codexServer(steps: Json[]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const steps = ${JSON.stringify(steps)};
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'U1' } } });
        for (const step of steps) send(JSON.parse(JSON.stringify(step).split('{{turn}}').join('U1')));
      }
    } });
  `;
}

const codexFixture: Fixture = {
  name: 'codex app-server (item/*, turn/plan/updated, thread/tokenUsage/updated, sub-agent threads; codex-cli 0.155 schema)',
  expected: caps(true, true, true, true, true),
  parents: ['agent:C'],
  thoughtFrames: { r1: 2 },
  run: async () => {
    const item = (method: string, threadId: string, turnId: string, body: Json) => ({ method, params: { threadId, turnId, item: body } });
    const session = createCodexSession({
      spawn: (_binary, _argv, options) => spawn(process.execPath, ['-e', codexServer([
        { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'T', turnId: '{{turn}}', itemId: 'r1', delta: 'Look at' } },
        { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'T', turnId: '{{turn}}', itemId: 'r1', delta: ' the repo' } },
        item('item/completed', 'T', '{{turn}}', { type: 'reasoning', id: 'r1', summary: ['Look at the repo'] }),
        item('item/started', 'T', '{{turn}}', { type: 'commandExecution', id: 'cmd1', command: 'ls', status: 'inProgress' }),
        item('item/completed', 'T', '{{turn}}', { type: 'commandExecution', id: 'cmd1', command: 'ls', status: 'completed', aggregatedOutput: 'a.ts\n', exitCode: 0 }),
        { method: 'turn/plan/updated', params: { threadId: 'T', turnId: '{{turn}}', plan: [{ step: 'Read', status: 'completed' }] } },
        item('item/started', 'T', '{{turn}}', { type: 'subAgentActivity', id: 'spawn1', kind: 'started', agentThreadId: 'C', agentPath: '/root/explore' }),
        { method: 'turn/started', params: { threadId: 'C', turn: { id: 'CU1', status: 'inProgress' } } },
        item('item/started', 'C', 'CU1', { type: 'commandExecution', id: 'child1', command: 'grep -r TODO .', status: 'inProgress' }),
        item('item/completed', 'C', 'CU1', { type: 'commandExecution', id: 'child1', command: 'grep -r TODO .', status: 'completed', aggregatedOutput: 'a.ts: TODO\n', exitCode: 0 }),
        { method: 'turn/completed', params: { threadId: 'C', turn: { id: 'CU1', status: 'completed' } } },
        { method: 'thread/tokenUsage/updated', params: { threadId: 'T', turnId: '{{turn}}', tokenUsage: { total: { totalTokens: 120, inputTokens: 100, outputTokens: 20 }, last: { totalTokens: 120, inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200000 } } },
        item('item/completed', 'T', '{{turn}}', { type: 'agentMessage', id: 'm1', text: 'Done.' }),
        { method: 'turn/completed', params: { threadId: 'T', turn: { id: '{{turn}}', status: 'completed' } } },
      ])], options),
    });
    const { observed, observer } = recorder();
    // Thoughts stream through onThought; they are rows of the turn all the same.
    const thoughts: Array<{ id?: string }> = [];
    try {
      await session.runTurn({
        binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask', ...observer,
        onThought: (_text, id) => { thoughts.push({ id }); observed.events.push({ kind: 'thinking', label: 'thought', ...(id ? { id } : {}) }); },
      });
    } finally { await session.close(); }
    return observed;
  },
};

/** The ACP client against a fake agent. `shape` is how the agent says an update
 * belongs to a sub-agent's call: Claude's bridge (_meta.claudeCode), Qwen Code
 * (_meta.parentToolCallId + subagentType, from its own conformance fixture), or
 * cursor-agent (a session of its own, announced by subagent_spawned). */
function acpFixture(shape: 'claude' | 'qwen' | 'cursor'): Fixture {
  const childMeta = { claude: { claudeCode: { parentToolUseId: 'task1' } }, qwen: { parentToolCallId: 'task1', subagentType: 'explore' }, cursor: undefined }[shape];
  const script = `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const update = (u, sessionId = 's1') => send({ method: 'session/update', params: { sessionId, update: u } });
    const childSession = ${JSON.stringify(shape === 'cursor' ? 's1.1' : 's1')};
    const meta = ${JSON.stringify(childMeta ?? null)};
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Look at ' } });
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the repo' } });
        update({ sessionUpdate: 'tool_call', toolCallId: 'read1', title: 'Read a.ts', kind: 'read', status: 'in_progress', rawInput: { file_path: 'a.ts' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'read1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'export const a = 1;' } }] });
        update({ sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed', priority: 'medium' }] });
        update({ sessionUpdate: 'tool_call', toolCallId: 'task1', title: 'Task', kind: 'other', status: 'in_progress', rawInput: { description: 'explore', subagent_type: 'explore' } });
        if (meta === null) update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 's1.1', name: 'explore', task: 'explore', capabilities: {}, _meta: { cursor: { toolCallId: 'task1', agentId: 'a1' } } });
        update({ sessionUpdate: 'tool_call', toolCallId: 'child1', title: 'grep TODO', kind: 'search', status: 'in_progress', rawInput: { pattern: 'TODO' }, ...(meta ? { _meta: meta } : {}) }, childSession);
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'child1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.ts: TODO' } }], ...(meta ? { _meta: meta } : {}) }, childSession);
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'task1', status: 'completed' });
        update({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
        send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200 } } });
      }
    } });
  `;
  return {
    name: `ACP, sub-agent as ${{ claude: "Claude's bridge (_meta.claudeCode.parentToolUseId)", qwen: "Qwen Code (_meta.parentToolCallId)", cursor: "cursor-agent (subagent_spawned + own session)" }[shape]}`,
    expected: caps(true, true, true, true, true),
    parents: ['task1'],
    thoughtFrames: { 'thought-1': 2 },
    run: async () => {
      const session = createAcpSession();
      const { observed, observer } = recorder();
      try {
        await session.runTurn({
          binary: process.execPath, command: 'acp-agent', argv: ['-e', script], cwd: process.cwd(), prompt: 'go',
          environment: {}, permissionMode: 'ask', ...observer,
          onThought: (_text, id) => { observed.events.push({ kind: 'thinking', label: 'thought', ...(id ? { id } : {}) }); },
        });
      } finally { await session.close(); }
      return observed;
    },
  };
}

// --------------------------------------------------------------- fixtures

/** Claude Code stream-json (SDKAssistantMessage / SDKUserMessage / SDKResultMessage). */
const claudeStreamJson = cliFixture('claude stream-json', { command: 'claude', parser: 'claude-stream-json' }, [
  { type: 'assistant', message: { id: 'msg_1', content: [
    { type: 'thinking', thinking: 'Need to look at the file' },
    { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'a.ts' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'export const a = 1;' }] } },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'explore', subagent_type: 'Explore' } }] } },
  { type: 'assistant', parent_tool_use_id: 'task1', message: { id: 'msg_c', content: [{ type: 'tool_use', id: 'child1', name: 'Grep', input: { pattern: 'TODO' } }] } },
  { type: 'user', parent_tool_use_id: 'task1', message: { content: [{ type: 'tool_result', tool_use_id: 'child1', content: 'a.ts: TODO' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'found one' }] }, tool_use_result: { totalToolUseCount: 1, totalTokens: 900, totalDurationMs: 1200 } },
  { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'tool_use', id: 'todo1', name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }] } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo1', content: 'ok' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } },
], { expected: caps(true, true, true, true, true), parents: ['task1'] });

/** opencode `run --format json` (tool_use parts, reasoning part, step_finish tokens). */
const opencodeJson = cliFixture('opencode run --format json', { command: 'opencode', parser: 'opencode-json' }, [
  { type: 'reasoning', part: { id: 'prt_r', type: 'reasoning', text: 'Weigh the options' } },
  { type: 'tool_use', part: { id: 'prt_t', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } } },
  { type: 'tool_use', part: { id: 'prt_t', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.ts\nb.ts' } } },
  { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 100, output: 20, reasoning: 0 }, cost: 0.001 } },
], { expected: caps(false, true, false, true, true) });

/** Goose `--output-format stream-json`: toolRequest / toolResponse content parts. */
const gooseJson = cliFixture('goose stream-json', { command: 'goose', parser: 'goose' }, [
  { type: 'message', message: { id: 'g1', role: 'assistant', content: [
    { type: 'thinking', thinking: 'Plan the change' },
    { type: 'toolRequest', id: 'req1', toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command: 'ls' } } } },
  ] } },
  { type: 'message', message: { id: 'g2', role: 'user', content: [
    { type: 'toolResponse', id: 'req1', toolResult: { status: 'success', value: [{ type: 'text', text: 'a.ts' }] } },
  ] } },
  { type: 'complete', total_tokens: 120, input_tokens: 100, output_tokens: 20 },
], { expected: caps(false, true, false, true, true) });

/** Cline `--json` (crafted from ClineSay; see events/cline.vitest.test.ts). */
const clineJson = cliFixture('cline --json', { command: 'cline', parser: 'cline-json' }, [
  { type: 'say', say: 'reasoning', ts: 1, text: 'Check config' },
  { type: 'say', say: 'tool', ts: 2, text: JSON.stringify({ tool: 'readFile', path: 'a.ts' }) },
  { type: 'say', say: 'command', ts: 3, text: 'npm test' },
  { type: 'say', say: 'command_output', ts: 4, text: 'PASS' },
  { type: 'say', say: 'completion_result', ts: 5, text: 'Done.' },
], { expected: caps(false, true, false, false, true) });

/** Pi's JSON event stream (packages/coding-agent/docs/json.md). */
const piJson = cliFixture('pi --mode json', { command: 'pi', parser: 'pi-json' }, [
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0, partial: { content: [{ type: 'thinking', thinking: '' }] } } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Look', partial: { content: [{ type: 'thinking', thinking: 'Look' }] } } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: ' around', partial: { content: [{ type: 'thinking', thinking: 'Look around' }] } } },
  { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'bash', args: { command: 'ls' } },
  { type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'a.ts' }] } },
  { type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.001 } } } },
], { expected: caps(false, true, false, true, true), thoughtFrames: { 'thinking:pi-1': 2 } });

/** cursor-agent `--output-format stream-json`. */
const cursorJson = cliFixture('cursor-agent stream-json', { command: 'cursor', parser: 'cursor-stream-json' }, [
  { type: 'thinking', subtype: 'delta', text: 'Look ' },
  { type: 'thinking', subtype: 'delta', text: 'around' },
  { type: 'thinking', subtype: 'completed' },
  { type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' } } } },
  { type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'a.ts\n', exitCode: 0 } } } } },
  { type: 'result', subtype: 'success', result: 'Done.', usage: { inputTokens: 100, outputTokens: 20 } },
], { expected: caps(false, true, false, true, true), thoughtFrames: { 'thinking:cursor-1': 2 } });

/** agy `--output-format stream-json` (verified against agy 1.2.7 in tools.ts). */
const antigravityJson = cliFixture('antigravity stream-json', { command: 'antigravity', parser: 'antigravity' }, [
  { event: 'step_update', step_update: { step_type: 'tool', step_index: 1, state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } } },
  { event: 'step_update', step_update: { step_type: 'tool', step_index: 1, state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } } },
  { event: 'result', result: { status: 'SUCCESS', response: 'Done.', usage: { input_tokens: 100, output_tokens: 20 } } },
], { expected: caps(false, false, false, true, false) });

/** The shape-matching reader every generic-json harness is read by. */
const genericJson = cliFixture('generic json-lines (item.* envelopes)', { command: 'generic', parser: 'generic-json' }, [
  { type: 'item.completed', item: { id: 'rs1', type: 'reasoning', summary: ['Weighing'] } },
  { type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'ls' } },
  { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts', exit_code: 0 } },
  { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
], { expected: caps(false, true, false, true, true) });

/** Aider: plain text with a `Tokens:` footer. */
const aiderText = cliFixture('aider text', { command: 'aider', parser: 'aider', turn: { output: 'text' } as never }, [
  'Aider v0.86.0', 'Here is the answer.', 'Tokens: 1.2k sent, 45 received.',
], { expected: caps(false, false, false, true, false) });

/** A text-only CLI (Continue `cn`): nothing structured at all. */
const plainText = cliFixture('plain text CLI', { command: 'cn', parser: 'text', turn: { output: 'text' } as never }, ['Hello', 'World'],
  { expected: caps(false, false, false, false, false) });

/** The fixtures a family is named by. `exact`: a harness reaching it must declare
 * exactly what it produced; otherwise the declaration is bounded by it. */
interface Family { fixtures: readonly Fixture[]; exact: boolean }
const FAMILIES: Readonly<Record<string, Family>> = {
  'claude-stream-json': { fixtures: [claudeStreamJson], exact: true },
  'codex-items': { fixtures: [codexFixture], exact: true },
  'pi-json': { fixtures: [piJson], exact: true },
  antigravity: { fixtures: [antigravityJson], exact: true },
  aider: { fixtures: [aiderText], exact: true },
  text: { fixtures: [plainText], exact: true },
  // Ceilings: what the adapter can produce; the vendor decides what it sends.
  acp: { fixtures: [acpFixture('claude'), acpFixture('qwen'), acpFixture('cursor')], exact: false },
  'generic-json': { fixtures: [genericJson], exact: false },
  // Own-parser families a harness reaches only as a fallback transport.
  'opencode-json': { fixtures: [opencodeJson], exact: false },
  goose: { fixtures: [gooseJson], exact: false },
  'cline-json': { fixtures: [clineJson], exact: false },
  'cursor-stream-json': { fixtures: [cursorJson], exact: false },
};

/** The family a harness's PRIMARY transport reaches, from what the catalog
 * declares (transport, then parser), never from its name. */
function familyOf(harness: AiLocalHarnessDefinition): string {
  const transport = harnessTurnTransport(harness);
  if (transport === 'codex-app-server') return 'codex-items';
  if (transport === 'acp') return 'acp';
  return harness.parser ?? 'generic-json';
}

// ------------------------------------------------------------- the rules

function check(label: string, ok: boolean, rule: string): void {
  expect(ok, `${label}: ${rule}`).toBe(true);
}

/** Standard sections 2, 4, 5, 12 over what one fixture emitted. */
function assertStandard(label: string, fixture: Fixture, observed: Observed): void {
  const calls = new Map<string, HarnessActivityEvent[]>();
  for (const event of observed.events) {
    if (event.kind === 'thinking') continue;
    // A frame with no id merges into the open call of its label, else is its own row: never dropped.
    const key = event.id ?? `label:${event.label}`;
    calls.set(key, [...(calls.get(key) ?? []), event]);
  }
  for (const [id, frames] of calls) {
    check(label, frames[0]!.kind === 'tool-start' || !frames[0]!.id, `section 12: call ${id} must begin with a start frame, began with ${frames[0]!.kind}`);
    const terminals = frames.filter((frame) => frame.kind === 'tool-done' || frame.kind === 'tool-error');
    check(label, terminals.length === 1, `section 12: call ${id} must have exactly one done|error frame, has ${terminals.length}`);
    check(label, frames.at(-1) === terminals[0], `section 2: call ${id} has frames after its terminal one (a finished row is never reopened)`);
  }
  // Rows: one per id, however many frames (no duplicates from one id).
  let rows: ReturnType<typeof upsertActivityEvent> = [];
  for (const [index, event] of observed.events.entries()) rows = upsertActivityEvent(rows, 0, 0, event, index + 1);
  const ids = new Set(observed.events.filter((event) => event.kind !== 'thinking' && event.id).map((event) => event.id));
  check(label, rows.filter((row) => row.event?.id).length === ids.size, `section 2: ${rows.filter((row) => row.event?.id).length} rows for ${ids.size} call ids (one id must be one row)`);
  // Children.
  const children = observed.events.filter((event) => event.parentId);
  for (const parent of fixture.parents ?? []) {
    const row = observed.events.find((event) => event.id === parent);
    check(label, Boolean(row), `section 5: parent call ${parent} was never emitted`);
    check(label, row?.agent === true, `section 5: the spawning call ${parent} must be agent:true`);
    check(label, children.some((event) => event.parentId === parent), `section 5: no child carries parentId ${parent}`);
  }
  for (const child of children) {
    check(label, (fixture.parents ?? []).includes(child.parentId!) || observed.events.some((event) => event.id === child.parentId),
      `section 5: ${child.id ?? child.label} names parent ${child.parentId}, which is not a row`);
  }
  // Thinking: every thought keyed, one id per thought.
  const thoughts = observed.events.filter((event) => event.kind === 'thinking');
  for (const thought of thoughts) check(label, Boolean(thought.id), `section 4: thought "${thought.label.slice(0, 30)}" has no id, so a settled thought cannot be keyed`);
  for (const [id, frames] of Object.entries(fixture.thoughtFrames ?? {})) {
    check(label, thoughts.filter((thought) => thought.id === id).length >= frames, `section 4: thought ${id} must keep one id across its ${frames} frames, got ids ${JSON.stringify(thoughts.map((thought) => thought.id))}`);
  }
}

function produced(observed: Observed): AiHarnessFlowCapabilities {
  return {
    childActivity: observed.events.some((event) => event.parentId !== undefined),
    thinking: observed.events.some((event) => event.kind === 'thinking'),
    plan: observed.plans > 0,
    usage: observed.usage,
    toolOutput: observed.events.some((event) => (event.kind === 'tool-done' || event.kind === 'tool-error') && (event.output?.length ?? 0) > 0),
  };
}

// ----------------------------------------------------------------- tests

const observedByFamily = new Map<string, AiHarnessFlowCapabilities>();

describe('every family\'s fixture meets the standard, and supplies exactly what it is declared to', () => {
  for (const [family, { fixtures }] of Object.entries(FAMILIES)) {
    for (const fixture of fixtures) {
      it(`${family}: ${fixture.name}`, async () => {
        const observed = await fixture.run();
        const label = `conformance[${family}: ${fixture.name}]`;
        assertStandard(label, fixture, observed);
        const got = produced(observed);
        for (const capability of CAPABILITIES) {
          check(label, got[capability] === fixture.expected[capability],
            `produced ${capability}=${got[capability]} but the family is declared to supply ${capability}=${fixture.expected[capability]}`);
        }
        const merged = observedByFamily.get(family) ?? caps(false, false, false, false, false);
        observedByFamily.set(family, Object.fromEntries(CAPABILITIES.map((capability) => [capability, merged[capability] || got[capability]])) as unknown as AiHarnessFlowCapabilities);
      });
    }
  }
});

describe('every catalog harness declares what its adapter supplies', () => {
  it('has a declaration for all five, on every harness', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      const declared = harness.capabilities;
      check(`conformance[${harness.command}]`, Boolean(declared), 'catalog: no `capabilities` declared (section 12: a vendor that cannot supply one is marked in the catalog)');
      for (const capability of CAPABILITIES) {
        check(`conformance[${harness.command}]`, typeof declared?.[capability] === 'boolean', `catalog: capabilities.${capability} is not declared`);
      }
    }
  });

  it('reaches a family with a fixture, and claims nothing the family cannot produce', () => {
    for (const harness of AI_LOCAL_HARNESSES) {
      const family = familyOf(harness);
      const label = `conformance[${harness.command}]`;
      check(label, family in FAMILIES, `its primary transport reaches family "${family}", which has no conformance fixture`);
      const { fixtures, exact } = FAMILIES[family]!;
      const supplied = fixtures.reduce((merged, fixture) => Object.fromEntries(CAPABILITIES.map((capability) => [capability, merged[capability] || fixture.expected[capability]])) as unknown as AiHarnessFlowCapabilities,
        caps(false, false, false, false, false));
      for (const capability of CAPABILITIES) {
        const declared = harness.capabilities?.[capability] === true;
        if (declared) check(label, supplied[capability], `declares ${capability} but its adapter family "${family}" cannot produce it`);
        else if (exact) check(label, !supplied[capability], `declares no ${capability} but its adapter family "${family}" produces it (a hidden capability: declare it, or stop reading it)`);
      }
    }
  });
});
