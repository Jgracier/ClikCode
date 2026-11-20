/** A task the vendor backgrounded (a shell, a Monitor) is work the conversation still owes an answer for after the turn
 * that started it ends, whether or not a process of it shows in the child's group. The session worker replaces itself
 * for a newer build only when no such work runs, so the count has to include the vendor's own task list: a worker that
 * did not saw replaced itself under a running Monitor. The agent is a real child speaking the `_claude/sdkMessage`
 * frames claude-agent-acp sends; it starts no process, so only the task list can say the work runs. */
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';

const agent = (): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      frame({ type: 'system', subtype: 'task_started', task_id: 'mon1', task_type: 'local_bash', description: 'watch', is_backgrounded: true });
      setTimeout(() => {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }, 100);
      setTimeout(() => frame({ type: 'system', subtype: 'task_notification', task_id: 'mon1', status: 'completed', summary: 'done' }), 1500);
    }
  } });
`;

describe('work the vendor backgrounded', () => {
  it('holds the worker after the turn that started it, until the vendor says it ended', async () => {
    const session = createAcpSession({ commandWatchMs: 200, backgroundTurns: () => undefined });
    try {
      await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', agent()], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' } as never);
      expect(await session.backgroundWorkRunning()).toBe(true);
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
    } finally { await session.close(); }
  }, 20_000);
});
