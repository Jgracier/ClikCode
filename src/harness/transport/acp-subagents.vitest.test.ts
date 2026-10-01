/** Claude Code's sub-agents and late tool detail, as claude-agent-acp 0.84
 * reports them: every sub-agent update stamped with
 * `_meta.claudeCode.parentToolUseId`, and an Edit's final diff sent after
 * the call already completed. Driven by a real child speaking ACP. */
import { expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { upsertActivityEvent } from '../../tui/render/activity-log.js';
import { createPendingWorkTracker } from '../../turn/pending-work.js';
import type { HarnessActivityEvent } from '../prompter.js';

const meta = (parent: string) => ({ claudeCode: { parentToolUseId: parent } });
const agent = `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'agent1', title: 'Explore the repo', kind: 'think', status: 'in_progress', rawInput: { description: 'Explore the repo', subagent_type: 'Explore' } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking for the config.' }, _meta: ${JSON.stringify(meta('agent1'))} });
      update({ sessionUpdate: 'tool_call', toolCallId: 'child1', title: 'Read package.json', kind: 'read', status: 'in_progress', rawInput: { file_path: 'package.json' }, _meta: ${JSON.stringify(meta('agent1'))} });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'child1', status: 'completed', _meta: ${JSON.stringify(meta('agent1'))} });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The config is in package.json.' }, _meta: ${JSON.stringify(meta('agent1'))} });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'agent1', status: 'completed' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit1', title: 'Edit a.ts', kind: 'edit', status: 'in_progress', rawInput: { file_path: 'a.ts' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit1', status: 'completed' });
      // PostToolUse's final diff: no status, after the completion.
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit1', content: [{ type: 'diff', path: 'a.ts', oldText: 'x = 1', newText: 'x = 2' }] });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

it("keeps a sub-agent's work under its Agent row and out of the answer, and never reopens a finished call", async () => {
  const session = createAcpSession();
  const events: HarnessActivityEvent[] = [];
  let answer = '';
  try {
    await session.runTurn({
      binary: process.execPath, command: 'claude', argv: ['-e', agent], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask', onActivity: (event) => events.push(event), onResponseDelta: (delta) => { answer += delta; },
    });
  } finally { await session.close(); }

  expect(answer).toBe('Done.');
  // The sub-agent's thinking, call and words are all its parent's.
  expect(events.filter((event) => event.parentId === 'agent1').map((event) => [event.kind, event.id ?? event.label]))
    .toEqual([['thinking', 'Looking for the config.'], ['tool-start', 'child1'], ['tool-done', 'child1'], ['thinking', 'The config is in package.json.']]);
  // The late diff settles into the finished edit.
  const late = events.filter((event) => event.id === 'edit1');
  expect(late.map((event) => event.kind)).toEqual(['tool-start', 'tool-done', 'tool-done']);
  expect(late[2]!.diff).toMatchObject({ removed: ['x = 1'], added: ['x = 2'], files: [{ path: 'a.ts', additions: 1, removals: 1 }] });

  // One row for the edit, finished, carrying the diff.
  let entries = upsertActivityEvent([], 0, 0, late[0]!, 1);
  entries = upsertActivityEvent(entries, 0, 0, late[1]!, 2);
  entries = upsertActivityEvent(entries, 0, 0, { ...late[2]!, kind: 'tool-start' }, 3);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.event).toMatchObject({ kind: 'tool-done', diff: { removed: ['x = 1'], added: ['x = 2'] } });

  // A repeat completion for a finished call settles nothing else.
  const pending = createPendingWorkTracker('claude');
  pending.note({ kind: 'tool-start', label: 'a', id: 'a' });
  pending.note({ kind: 'tool-start', label: 'b', id: 'b' });
  pending.note({ kind: 'tool-done', label: 'a', id: 'a' });
  pending.note({ kind: 'tool-done', label: 'a', id: 'a' });
  expect(pending.outstanding).toBe(1);
});
