/** A background sub-agent's row, whichever family reports it.
 *
 * The same logical run -- launched in the background (its launching call
 * RETURNS at once), progress with tool uses and tokens, then its own end --
 * is fed through each family's REAL adapter: Claude stream-json (the recorded
 * claude 2.1.281 stream), claude-agent-acp's raw task frames, and Cursor's
 * `subagent_spawned`/`subagent_state_update`. What the saved turn and the
 * terminal draw must be the same: one row, still running (the ring spinner's
 * state) until the agent's own end, never settled at launch; stopped it reads
 * as stopped; the terminal and the webview group it in the same words.
 * Codex's own lifecycle (subAgentActivity / child turn events) is held by
 * transport/codex-app-server-waiting.vitest.test.ts; the own agent's by
 * agent/subagent.vitest.test.ts (`continuesAs`). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import { createStreamState } from '../events/adapters.js';
import { reportStructuredLine } from '../events/structured.js';
import { createAcpSession } from '../transport/acp-client.js';
import { stopOpenActivities } from '../../turn/turn-activities.js';
import { recordTurnActivity } from '../../turn/turn-activities.js';
import type { TurnActivity } from '../../session/model.js';
import { normalizeActivityEvent } from './activity-normalize.js';
import { renderActivityLine } from './activity-line.js';
import { groupSummary, groupSummaryText } from './call-groups.js';
import { runGroupSummary } from '../../../packages/vscode/src/webview/flow.js';

const plain = (rows: string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
const settle = (events: readonly HarnessActivityEvent[]): TurnActivity[] => {
  let activities: TurnActivity[] = [];
  for (const event of events) activities = recordTurnActivity(activities, normalizeActivityEvent(event), 0);
  return activities;
};

it('keeps an Amp async Task running through its launch result, then settles it on the native end event', () => {
  const harness = { command: 'amp', parser: 'claude-stream-json', turn: { stdinFormat: 'amp-json' } } as AiLocalHarnessDefinition;
  const stream = createStreamState();
  const events: HarnessActivityEvent[] = [];
  const counts: number[] = [];
  const note = (record: object) => reportStructuredLine(harness, JSON.stringify(record), {
    onActivity: (event) => events.push(event), onBackgroundWork: (work) => counts.push(work.agents ?? 0),
  }, stream);
  note({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task', name: 'Task', input: { description: 'review', mode: 'async' } }] } });
  note({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task', content: 'launched' }] } });
  expect(events.filter((event) => event.id === 'task').map((event) => event.kind)).toEqual(['tool-start']);
  expect(counts.at(-1)).toBe(1);
  note({ type: 'system', subtype: 'subagent_finished', tool_use_id: 'task', status: 'completed' });
  expect(events.filter((event) => event.id === 'task').map((event) => event.kind)).toEqual(['tool-start', 'tool-done']);
  expect(counts.at(-1)).toBe(0);
});

/** The frames of one agent row, in order, from the claude 2.1.281 recording. */
function claudeStreamJson(): HarnessActivityEvent[] {
  const lines = readFileSync(join(__dirname, '..', 'transport', 'native', 'fixtures', 'claude-background-agent.jsonl'), 'utf8').split('\n').filter((line) => line.trim());
  const harness = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;
  const state = createStreamState();
  const events: HarnessActivityEvent[] = [];
  for (const line of lines) reportStructuredLine(harness, line, { onActivity: (event) => events.push(event) }, state);
  return events.filter((event) => event.id === 'toolu_013yyax3JAMzifVzKLgUP5DF');
}

/** A fake ACP agent: plays `steps` after session/prompt, then ends the turn. */
async function acpRun(steps: Array<Record<string, unknown>>): Promise<HarnessActivityEvent[]> {
  const script = `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const steps = ${JSON.stringify(steps)}; let buf = '';
    process.stdin.on('data', async (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') { for (const s of steps) { send(s); await new Promise((r) => setTimeout(r, 10)); } send({ id: m.id, result: { stopReason: 'end_turn' } }); }
    } });`;
  const session = createAcpSession({});
  const events: HarnessActivityEvent[] = [];
  try {
    await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', script], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
      onActivity: (event: HarnessActivityEvent) => events.push(event),
    } as never);
  } finally { await session.close(); }
  return events;
}
const update = (u: Record<string, unknown>) => ({ method: 'session/update', params: { sessionId: 's1', update: u } });
const raw = (message: Record<string, unknown>) => ({ method: '_claude/sdkMessage', params: { sessionId: 's1', message: { type: 'system', ...message } } });
const launch = (extra: Record<string, unknown> = {}) => update({ sessionUpdate: 'tool_call', toolCallId: 'a1', title: 'Agent', kind: 'other', status: 'in_progress', rawInput: { description: 'scan the repo', subagent_type: 'general-purpose' }, ...extra });
const returned = update({ sessionUpdate: 'tool_call_update', toolCallId: 'a1', status: 'completed' });

const FAMILIES: Array<{ name: string; frames: () => Promise<HarnessActivityEvent[]>; id: string }> = [
  { name: 'Claude stream-json (recorded claude 2.1.281)', id: 'toolu_013yyax3JAMzifVzKLgUP5DF', frames: async () => claudeStreamJson() },
  {
    name: 'Claude Code over ACP (claude-agent-acp task frames)', id: 'a1',
    frames: () => acpRun([launch(), raw({ subtype: 'task_started', task_id: 'T', tool_use_id: 'a1', subagent_type: 'general-purpose', is_backgrounded: true }), returned,
      raw({ subtype: 'task_progress', task_id: 'T', tool_use_id: 'a1', usage: { total_tokens: 900, tool_uses: 1, duration_ms: 1000 } }),
      raw({ subtype: 'task_notification', task_id: 'T', tool_use_id: 'a1', status: 'completed', usage: { total_tokens: 900, tool_uses: 1, duration_ms: 11067 } })]),
  },
  {
    name: 'Cursor over ACP (subagent_spawned / subagent_state_update)', id: 'a1',
    frames: () => acpRun([launch(), update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'scan', _meta: { cursor: { toolCallId: 'a1' } } }), returned,
      update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' })]),
  },
];

describe('a background sub-agent is one row that runs until the agent itself ends, in every family', () => {
  for (const family of FAMILIES) {
    describe(family.name, () => {
      it('never settles at the launching call: its frames end with exactly one done, after the launch result', async () => {
        const mine = (await family.frames()).filter((event) => event.id === family.id);
        const kinds = mine.map((event) => event.kind);
        expect(kinds.filter((kind) => kind !== 'tool-start')).toEqual(['tool-done']);
        expect(kinds.at(-1)).toBe('tool-done');
        expect(mine.every((event) => event.agent === true || event.kind === 'tool-done')).toBe(true);
        // While the agent runs, the saved row is still open (the ring spinner draws it).
        const beforeEnd = settle(mine.slice(0, -1)).find((activity) => activity.event.id === family.id)!.event;
        expect(beforeEnd.kind).toBe('tool-start');
        expect(normalizeActivityEvent(beforeEnd).agent).toBe(true);
      });

      it('is one row, drawn as the standard agent row once it ended', async () => {
        const rows = settle(await family.frames()).filter((activity) => !activity.event.parentId);
        const agents = rows.filter((activity) => activity.event.agent);
        expect(agents).toHaveLength(1);
        expect(agents[0]!.event.kind).toBe('tool-done');
        expect(plain(renderActivityLine(agents[0]!.event))[0]).toMatch(/^ {2}‣ Agent /);
      });

      it('reads as stopped when the turn is stopped under it, in the saved turn', async () => {
        const open = (await family.frames()).filter((event) => event.kind === 'tool-start');
        const stopped = stopOpenActivities(settle(open)).find((activity) => activity.event.agent)!.event;
        expect(stopped.stopped).toBe(true);
        expect(plain(renderActivityLine(stopped)).join(' ')).toContain('stopped');
      });

      it('is grouped by the terminal and the webview in the same words', async () => {
        const calls = settle(await family.frames()).map((activity) => activity.event);
        const terminal = groupSummaryText(groupSummary(calls.map((event, index) => ({ id: String(index), event })), false));
        const webview = runGroupSummary(calls.map((event, index) => ({ activity: { ...event, key: String(index) } as never })));
        expect(webview).toBe(terminal);
      });
    });
  }

  it('all three families draw the same row for the same run', async () => {
    const drawn = await Promise.all(FAMILIES.map(async (family) => {
      const agent = settle(await family.frames()).find((activity) => activity.event.agent)!.event;
      return { kind: agent.kind, agent: agent.agent, category: agent.category, glyph: plain(renderActivityLine(agent))[0]!.slice(0, 5) };
    }));
    for (const row of drawn.slice(1)) expect(row).toEqual(drawn[0]);
  });
});
