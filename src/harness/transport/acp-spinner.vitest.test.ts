/** What the editor and terminal animate while an ACP agent runs: a "connecting to …" label that ends
 * with the connection, and work the agent does between prompts that ends when it goes quiet. Driven
 * by a real child speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { VendorBackgroundTurn } from './background-turn.js';

/** An agent whose `initialize` takes `startMs`, answers one prompt, then does `after` -- sent with no prompt open. */
function agent(startMs: number, after: Array<{ delay: number; update: Record<string, unknown> }>): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') setTimeout(() => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }), ${startMs});
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
        let at = 0;
        for (const step of ${JSON.stringify(after)}) { at += step.delay; setTimeout(() => send({ method: 'session/update', params: { sessionId: 's1', update: step.update } }), at); }
      }
    } });
  `;
}
const input = (script: string, extra: Record<string, unknown> = {}) => ({
  binary: process.execPath, command: 'fake', argv: ['-e', script], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' as const, ...extra,
});

describe('the "connecting to" label', () => {
  it('is replaced once the agent is connected, instead of standing for the whole turn', async () => {
    const phases: string[] = [];
    const session = createAcpSession({ idleMs: 0 });
    try {
      await session.runTurn(input(agent(1300, []), { onPhase: (phase: string) => phases.push(phase) }));
    } finally { await session.close(); }
    expect(phases).toEqual(['connecting to fake', 'thinking']);
  });

  it('is never shown for an agent that answers at once', async () => {
    const phases: string[] = [];
    const session = createAcpSession({ idleMs: 0 });
    try {
      await session.runTurn(input(agent(0, []), { onPhase: (phase: string) => phases.push(phase) }));
    } finally { await session.close(); }
    expect(phases).toEqual([]);
  });
});

describe('work an agent does between prompts', () => {
  const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late news' } };

  it('ends when it goes quiet, instead of animating until the user types', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ idleMs: 0, backgroundQuietMs: 300, backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input(agent(0, [{ delay: 100, update: chunk }])));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(turns).toHaveLength(1);
      expect(await Promise.race([turns[0]!.finished, new Promise((resolve) => setTimeout(() => resolve('still running'), 3000))])).toEqual({ text: expect.any(String), ended: 'completed' });
    } finally { await session.close(); }
  });

  it('keeps running while a tool it started has not settled', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ idleMs: 0, backgroundQuietMs: 200, backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input(agent(0, [{ delay: 100, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run build', kind: 'execute', status: 'in_progress' } }])));
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(await Promise.race([turns[0]!.finished, new Promise((resolve) => setTimeout(() => resolve('still running'), 50))])).toBe('still running');
    } finally { await session.close(); }
  });
});
