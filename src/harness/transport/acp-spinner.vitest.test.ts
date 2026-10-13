/** What the editor and terminal animate while an ACP agent runs: a "connecting to …" label that ends
 * with the connection, and work the agent does between prompts, which shows as working only while a tool it reports runs. Driven
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
    const session = createAcpSession();
    try {
      await session.runTurn(input(agent(1300, []), { onPhase: (phase: string) => phases.push(phase) }));
    } finally { await session.close(); }
    expect(phases).toEqual(['connecting to fake', 'thinking']);
  });

  it('is never shown for an agent that answers at once', async () => {
    const phases: string[] = [];
    const session = createAcpSession();
    try {
      await session.runTurn(input(agent(0, []), { onPhase: (phase: string) => phases.push(phase) }));
    } finally { await session.close(); }
    expect(phases).toEqual([]);
  });
});

describe('work an agent does between prompts', () => {
  const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late news' } };
  const thought = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } };
  const running = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run build', kind: 'execute', status: 'in_progress' };
  const settled = { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('relays a trailing message or thought into the conversation and opens no working turn', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const said: Array<{ kind: string; text: string; mode: string }> = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn), outOfTurn: (what) => said.push(what) });
    try {
      await session.runTurn(input(agent(0, [{ delay: 50, update: chunk }, { delay: 20, update: thought }])));
      await wait(400);
      expect(turns).toHaveLength(0);
      expect(said).toEqual([
        { kind: 'message', text: 'late news', mode: 'append' },
        { kind: 'thought', text: 'pondering', mode: 'append' },
      ]);
    } finally { await session.close(); }
  });

  it('keeps working while a tool it reports in progress has not settled, however long that takes', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input(agent(0, [{ delay: 50, update: running }])));
      await wait(1200);
      expect(turns).toHaveLength(1);
      expect(await Promise.race([turns[0]!.finished, wait(50).then(() => 'still running')])).toBe('still running');
    } finally { await session.close(); }
  });

  it('ends when the vendor reports the tool settled, and what it says after that is relayed again', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const said: string[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn), outOfTurn: (what) => said.push(what.text) });
    try {
      await session.runTurn(input(agent(0, [{ delay: 50, update: running }, { delay: 50, update: chunk }, { delay: 50, update: settled }, { delay: 50, update: { ...chunk, content: { type: 'text', text: 'after' } } }])));
      await wait(100);
      expect(await Promise.race([turns[0]!.finished, wait(3000).then(() => 'still running')])).toEqual({ text: 'late news', ended: 'completed' });
      await wait(300);
      expect(turns).toHaveLength(1);
      expect(said).toEqual(['after']);
    } finally { await session.close(); }
  });
});
