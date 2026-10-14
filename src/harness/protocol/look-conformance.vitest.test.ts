/** One logical turn -- a thought, a command, a read, an edit with a diff, a
 * failed command, a sub-agent that ran a command -- fed through every
 * harness's REAL adapter parse function in the shape that harness publishes,
 * then through the one normalizer and the saved-turn merge. What comes out
 * (the events' look-relevant fields and the rows the terminal draws) must be
 * identical for every harness: the look is one standard, not one per vendor.
 *
 * Facts a vendor does not publish are not a look: Codex has no read tool (its
 * reads are commands, drawn as commands), opencode's sub-agent children run in
 * their own session, and only some vendors report an exit code. Those cases
 * are declared below, never silently skipped. */
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { eventDiff } from '../../agent/line-diff.js';
import { bashTool } from '../../agent/tools/bash.js';
import { editFileTool } from '../../agent/tools/edit-file.js';
import { readFileTool } from '../../agent/tools/read-file.js';
import { taskTool } from '../../agent/tools/task.js';
import { categoryForTool } from '../../agent/turn-support.js';
import { eventOutputPreview } from '../../agent/security.js';
import { recordTurnActivity } from '../../turn/turn-activities.js';
import type { TurnActivity } from '../../session/model.js';
import type { HarnessActivityEvent } from '../prompter.js';
import { acpActivityEvent } from '../transport/acp-client.js';
import { codexActivityForItem } from '../transport/codex-app-server.js';
import { parseNativeActivityEventsFromValue, thoughtLabel } from './activity-events.js';
import { renderActivityLine } from './activity-line.js';
import { groupSummary, groupSummaryText } from './call-groups.js';
import { normalizeActivityEvent } from './activity-normalize.js';
import { LOOK } from './look.js';
import { runGroupSummary } from '../../../packages/vscode/src/webview/flow.js';

const plain = (rows: string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
/** An exit code is a vendor's fact, shown as `(exit N)` only where reported. */
const withoutExit = (row: string): string => row.replace(/ \(exit \d+[^)]*\)/, '');

const THOUGHT = 'Planning the approach';

/** One harness's turn: raw frames, in the order the adapter emits them. */
interface HarnessTurn {
  name: string;
  thought: HarnessActivityEvent[];
  command: HarnessActivityEvent[];
  read?: HarnessActivityEvent[];
  edit: HarnessActivityEvent[];
  failed: HarnessActivityEvent[];
  agent: HarnessActivityEvent[];
  /** The sub-agent's child (a command), when the vendor reports children. */
  child?: HarnessActivityEvent[];
}

const claude = { command: 'claude', parser: 'claude-stream-json' } as never;
const opencode = { command: 'opencode', parser: 'opencode-json' } as never;
const codex = { command: 'codex', parser: 'codex-items' } as never;

const claudeTurn = (): HarnessTurn => {
  const use = (id: string, name: string, input: Record<string, unknown>, parent?: string) => parseNativeActivityEventsFromValue(claude, {
    type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id: string, content: string, isError = false, parent?: string) => parseNativeActivityEventsFromValue(claude, {
    type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });
  return {
    name: 'Claude Code (stream-json)',
    thought: parseNativeActivityEventsFromValue(claude, { type: 'assistant', message: { id: 'm0', content: [{ type: 'thinking', thinking: THOUGHT }] } }),
    command: [...use('c1', 'Bash', { command: 'npm test' }), ...result('c1', 'ok 1\nok 2')],
    read: [...use('r1', 'Read', { file_path: 'src/a.ts' }), ...result('r1', '1\tfoo')],
    edit: [...use('e1', 'Edit', { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' }), ...result('e1', 'updated')],
    failed: [...use('f1', 'Bash', { command: 'false' }), ...result('f1', 'boom', true)],
    agent: [...use('t1', 'Task', { description: 'explore the parser', prompt: 'look', subagent_type: 'Explore' }), ...result('t1', 'done')],
    child: [...use('k1', 'Bash', { command: 'grep -rn token src' }, 't1'), ...result('k1', 'x', false, 't1')],
  };
};

const codexTurn = (): HarnessTurn => {
  const item = (value: Record<string, unknown>, completed: boolean, parentId?: string): HarnessActivityEvent[] => {
    const event = codexActivityForItem(value as never, completed);
    return event ? [{ ...event, ...(parentId ? { parentId } : {}) }] : [];
  };
  const command = (id: string, text: string, output: string, failed = false, parentId?: string) => [
    ...item({ type: 'commandExecution', id, command: text }, false, parentId),
    ...item({ type: 'commandExecution', id, command: text, aggregatedOutput: output, exitCode: failed ? 1 : 0, status: failed ? 'failed' : 'completed' }, true, parentId),
  ];
  const change = { path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-foo\n+bar\n' };
  return {
    name: 'Codex (app-server)',
    thought: item({ type: 'reasoning', id: 'rs1', summary: [THOUGHT] }, true),
    command: command('c1', 'npm test', 'ok 1\nok 2'),
    // No read tool: a read is a shell command, drawn as one.
    edit: [...item({ type: 'fileChange', id: 'e1', changes: [change] }, false), ...item({ type: 'fileChange', id: 'e1', changes: [change], status: 'completed' }, true)],
    failed: command('f1', 'false', 'boom', true),
    agent: [...item({ type: 'collabAgentToolCall', id: 't1', tool: 'spawnAgent', prompt: 'explore the parser' }, false), ...item({ type: 'collabAgentToolCall', id: 't1', tool: 'spawnAgent', prompt: 'explore the parser', status: 'completed' }, true)],
    child: command('k1', 'grep -rn token src', 'x', false, 't1'),
  };
};

/** ACP `session/update` tool_call frames: claude-agent-acp's shape. */
const acpClaudeTurn = (): HarnessTurn => {
  const frames = (toolCallId: string, start: Record<string, unknown>, done: Record<string, unknown>, parent?: string): HarnessActivityEvent[] => {
    const meta = parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {};
    return [
      acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...start, ...meta }),
      acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...done, ...meta }),
    ].filter((event): event is HarnessActivityEvent => Boolean(event));
  };
  const text = (value: string) => ({ content: [{ type: 'content', content: { type: 'text', text: value } }] });
  return {
    name: 'ACP: claude-agent-acp',
    thought: [{ kind: 'thinking', label: thoughtLabel(THOUGHT) }],
    command: frames('c1', { title: '`npm test`', kind: 'execute', rawInput: { command: 'npm test' } }, { ...text('ok 1\nok 2'), _meta: { terminal_exit: { exit_code: 0 } } }),
    read: frames('r1', { title: 'Read src/a.ts', kind: 'read', rawInput: { file_path: 'src/a.ts' }, locations: [{ path: 'src/a.ts' }] }, text('1\tfoo')),
    edit: frames('e1', { title: 'Edit src/a.ts', kind: 'edit', rawInput: { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' } },
      { content: [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }] }),
    failed: frames('f1', { title: '`false`', kind: 'execute', rawInput: { command: 'false' } }, { status: 'failed', ...text('boom'), _meta: { terminal_exit: { exit_code: 1 } } }),
    agent: frames('t1', { title: 'explore the parser', kind: 'think', rawInput: { description: 'explore the parser', prompt: 'look', subagent_type: 'Explore' } }, {}),
    child: frames('k1', { title: '`grep -rn token src`', kind: 'execute', rawInput: { command: 'grep -rn token src' } }, text('x'), 't1'),
  };
};

/** ACP from a vendor with its own title sentences, field names and parent key. */
const acpOtherTurn = (): HarnessTurn => {
  const frames = (toolCallId: string, start: Record<string, unknown>, done: Record<string, unknown>, parent?: string): HarnessActivityEvent[] => {
    const meta = parent ? { _meta: { parentToolCallId: parent } } : {};
    return [
      acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId, status: 'in_progress', ...start, ...meta }),
      acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...done, ...meta }),
    ].filter((event): event is HarnessActivityEvent => Boolean(event));
  };
  const text = (value: string) => ({ content: [{ type: 'content', content: { type: 'text', text: value } }] });
  return {
    name: 'ACP: another vendor (titles as sentences, cmd/path inputs)',
    thought: [{ kind: 'thinking', label: thoughtLabel(`  ${THOUGHT}\n`) }],
    command: frames('c1', { title: 'Running npm test', kind: 'execute', rawInput: { cmd: 'npm test' } }, text('ok 1\nok 2')),
    read: frames('r1', { title: 'Reading src/a.ts', kind: 'read', rawInput: { path: 'src/a.ts' } }, text('1\tfoo')),
    edit: frames('e1', { title: 'Editing src/a.ts', kind: 'edit', rawInput: { path: 'src/a.ts' } }, { content: [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }] }),
    failed: frames('f1', { title: 'Running false', kind: 'execute', rawInput: { cmd: 'false' } }, { status: 'failed', ...text('boom') }),
    agent: frames('t1', { title: 'Task', kind: 'other', rawInput: { description: 'explore the parser', prompt: 'look' } }, {}),
    child: frames('k1', { title: 'Running grep -rn token src', kind: 'execute', rawInput: { cmd: 'grep -rn token src' } }, text('x'), 't1'),
  };
};

/** ACP from a vendor that sends titles and no raw input: its rows are the
 * vendor's own spelling (a backticked command, `Read(path)`), and an exit it
 * reports on a call it calls completed. Only the normalizer makes them the
 * standard row. */
const acpTitleOnlyTurn = (): HarnessTurn => {
  const frames = (toolCallId: string, start: Record<string, unknown>, done: Record<string, unknown>): HarnessActivityEvent[] => [
    acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId, status: 'in_progress', ...start }),
    acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...done }),
  ].filter((event): event is HarnessActivityEvent => Boolean(event));
  const text = (value: string) => ({ content: [{ type: 'content', content: { type: 'text', text: value } }] });
  return {
    name: 'ACP: title-only vendor (no raw input)',
    thought: [{ kind: 'thinking', label: `  ${THOUGHT}\n  ` }],
    command: frames('c1', { title: '`npm test`', kind: 'execute' }, text('ok 1\nok 2')),
    read: frames('r1', { title: 'Read(src/a.ts)', kind: 'read' }, text('1\tfoo')),
    edit: frames('e1', { title: 'Edit src/a.ts', kind: 'edit' }, { content: [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }] }),
    failed: frames('f1', { title: '`false`', kind: 'execute' }, { ...text('boom'), _meta: { terminal_exit: { exit_code: 1 } } }),
    agent: frames('t1', { name: 'Task', title: 'explore the parser', kind: 'think' }, {}),
  };
};

/** ClikDeploy Gateway / ClikCode Local: the loop's own tool labels and categories, as turn-tools.ts emits them. */
const agentTurn = (): HarnessTurn => {
  const call = (tool: { name: string; label: (args: never) => string }, id: string, args: Record<string, unknown>, result: { output: string; isError?: boolean; diff?: unknown; exitCode?: number }, parentId?: string): HarnessActivityEvent[] => {
    const label = tool.label(args as never);
    const category = categoryForTool(tool as never, args);
    const extra = parentId ? { parentId } : {};
    return [
      { kind: 'tool-start', label, id, ...category, ...extra },
      { kind: result.isError ? 'tool-error' : 'tool-done', label, id, ...category, ...eventOutputPreview(result.output), ...(result.diff ? { diff: result.diff as never } : {}), ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), ...extra },
    ] as HarnessActivityEvent[];
  };
  return {
    name: 'ClikDeploy Gateway agent / ClikCode Local',
    thought: [{ kind: 'thinking', label: thoughtLabel(THOUGHT), id: 'turn:reasoning:1' }],
    command: call(bashTool, 'c1', { command: 'npm test' }, { output: 'ok 1\nok 2', exitCode: 0 }),
    read: call(readFileTool, 'r1', { path: 'src/a.ts' }, { output: '1\tfoo' }),
    edit: call(editFileTool, 'e1', { path: 'src/a.ts', old_string: 'foo', new_string: 'bar' }, { output: 'ok', diff: eventDiff('foo', 'bar', { path: 'src/a.ts', numbered: true }) }),
    failed: call(bashTool, 'f1', { command: 'false' }, { output: 'boom', isError: true, exitCode: 1 }),
    agent: call(taskTool, 't1', { description: 'explore the parser', prompt: 'look' }, { output: 'done' }),
    child: call(bashTool, 't1/k1', { command: 'grep -rn token src' }, { output: 'x', exitCode: 0 }, 't1'),
  };
};

/** opencode / Kilo `run --format json`. */
const opencodeTurn = (): HarnessTurn => {
  const part = (callID: string, tool: string, status: string, input: Record<string, unknown>, output = '') =>
    parseNativeActivityEventsFromValue(opencode, { type: 'tool_use', part: { callID, tool, state: { status, input, ...(output ? { output } : {}) } } });
  const both = (id: string, tool: string, input: Record<string, unknown>, output: string, failed = false) =>
    [...part(id, tool, 'running', input), ...part(id, tool, failed ? 'error' : 'completed', input, output)];
  return {
    name: 'opencode (run --format json)',
    thought: parseNativeActivityEventsFromValue(opencode, { type: 'reasoning', part: { id: 'p1', text: THOUGHT } }),
    command: both('c1', 'bash', { command: 'npm test' }, 'ok 1\nok 2'),
    read: both('r1', 'read', { filePath: 'src/a.ts' }, '1\tfoo'),
    edit: both('e1', 'edit', { filePath: 'src/a.ts', oldString: 'foo', newString: 'bar' }, 'ok'),
    failed: both('f1', 'bash', { command: 'false' }, 'boom', true),
    agent: both('t1', 'task', { description: 'explore the parser', prompt: 'look', subagent_type: 'general' }, 'done'),
    // Children run in their own session: no child frames on this stream.
  };
};

const HARNESSES: HarnessTurn[] = [claudeTurn(), codexTurn(), acpClaudeTurn(), acpOtherTurn(), acpTitleOnlyTurn(), agentTurn(), opencodeTurn()];

/** The turn as the saved turn keeps it, each frame through the one normalizer. */
function settle(frames: readonly HarnessActivityEvent[]): TurnActivity[] {
  let activities: TurnActivity[] = [];
  for (const frame of frames) activities = recordTurnActivity(activities, normalizeActivityEvent(frame), 0);
  return activities;
}

/** What makes a row look the way it does, and nothing a vendor merely reported. */
const look = (event: HarnessActivityEvent) => ({
  kind: event.kind, label: event.label, category: event.category, agent: event.agent === true, parentId: event.parentId, stopped: event.stopped === true,
});

const EXPECTED = {
  thought: ['  ✻ Planning the approach'],
  command: ['  ‣ $ npm test'],
  read: ['  ‣ Read src/a.ts · 1 line'],
  edit: ['  ‣ Edited src/a.ts +1 -1'],
  failed: ['  ‣ $ false failed', '    boom'],
  agent: ['  ‣ Agent explore the parser (1 tool use)'],
  child: ['  ‣ $ grep -rn token src'],
};

const rowsOf = (activities: readonly TurnActivity[], parent?: boolean): string[] =>
  activities.filter((activity) => Boolean(activity.event.parentId) === Boolean(parent)).flatMap((activity) => plain(renderActivityLine(activity.event)).map(withoutExit));

describe('one look for every harness', () => {
  for (const turn of HARNESSES) {
    describe(turn.name, () => {
      const kinds = ['command', 'read', 'edit', 'failed', 'agent'] as const;
      for (const kind of kinds) {
        if (kind === 'read' && !turn.read) continue;
        it(`draws a ${kind} the standard way`, () => {
          // The agent row's count comes from its children, which are fed with it.
          const frames = kind === 'agent' ? [...turn[kind], ...(turn.child ?? [])] : turn[kind]!;
          const activities = settle(frames);
          const top = rowsOf(activities);
          // A vendor reporting no children has no count to show.
          const expected = kind === 'agent' && !turn.child ? [EXPECTED.agent[0]!.replace(' (1 tool use)', '')] : EXPECTED[kind];
          expect(top).toEqual(expected);
          // And every event reaching a surface is categorised or deliberately not (agents).
          for (const activity of activities) if (!activity.event.agent) expect(activity.event.category, activity.event.label).toBeDefined();
        });
      }

      it('draws a thought as one dim italic ✻ row', () => {
        const rows = plain(renderActivityLine(normalizeActivityEvent(turn.thought[0]!)));
        expect(rows).toEqual(EXPECTED.thought);
        const level = chalk.level;
        chalk.level = 2;
        try { expect(renderActivityLine(normalizeActivityEvent(turn.thought[0]!))[0]).toContain('\u001b[3m'); } finally { chalk.level = level; }
      });

      if (turn.child) {
        it("draws a sub-agent's child under it, as any other call", () => {
          const activities = settle([...turn.agent, ...turn.child]);
          expect(rowsOf(activities, true)).toEqual(EXPECTED.child);
          expect(activities.find((activity) => activity.event.agent)?.event.childTools).toBe(1);
        });
      }
    });
  }

  it('produces identical normalized events for the same logical call, whichever harness made it', () => {
    for (const kind of ['command', 'edit', 'failed'] as const) {
      const projections = HARNESSES.map((turn) => settle(turn[kind]!).map((activity) => look(activity.event)));
      for (const projection of projections.slice(1)) expect(projection, kind).toEqual(projections[0]);
    }
    const reads = HARNESSES.filter((turn) => turn.read).map((turn) => settle(turn.read!).map((activity) => look(activity.event)));
    for (const projection of reads.slice(1)) expect(projection).toEqual(reads[0]);
    const agents = HARNESSES.map((turn) => settle(turn.agent).map((activity) => look(activity.event)));
    for (const projection of agents.slice(1)) expect(projection).toEqual(agents[0]);
    const thoughts = HARNESSES.map((turn) => normalizeActivityEvent(turn.thought[0]!).label);
    for (const label of thoughts) expect(label).toBe(THOUGHT);
  });

  it('gives the terminal and the webview the same group summary for the same turn', () => {
    const summaries = HARNESSES.map((turn) => {
      const calls = [turn.command, turn.read ?? [], turn.edit, turn.failed].flatMap((frames) => settle(frames).map((activity) => activity.event));
      const items = calls.map((event, index) => ({ id: String(index), event }));
      const terminal = groupSummaryText(groupSummary(items, false));
      const webview = runGroupSummary(calls.map((event, index) => ({ activity: { ...event, key: String(index) } as never })));
      expect(webview, turn.name).toBe(terminal);
      return { terminal, hasRead: Boolean(turn.read) };
    });
    // Codex has no read tool, so its summary counts one more command; every other harness is the same words.
    const withRead = summaries.filter((entry) => entry.hasRead).map((entry) => entry.terminal);
    for (const text of withRead) expect(text).toBe(withRead[0]);
    expect(withRead[0]).toMatch(/^Ran 1 command, read 1 file/);
    expect(withRead[0]).toContain('1 failed');
  });

  it('uses the one tool glyph for every row, categorised or not', () => {
    for (const turn of HARNESSES) for (const frames of [turn.command, turn.agent]) {
      for (const row of renderActivityLine(normalizeActivityEvent(frames[0]!))) expect(row).toContain(LOOK.glyph.tool);
    }
    expect(renderActivityLine({ kind: 'tool-done', label: 'github › create_issue' })[0]).toContain(LOOK.glyph.tool);
  });
});

