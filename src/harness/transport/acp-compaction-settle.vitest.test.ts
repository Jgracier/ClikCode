/** An agent that answers `/compact` at once and compacts afterwards (Devin, Kiro): the turn is
 * the compaction, until the agent's own notification says it ended. Driven by a real child speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';

/** Answers session/prompt with end_turn, then `afterMs` later sends `method` with `status`. */
const agent = (method: string, status: unknown, afterMs: number): string => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      send({ id: m.id, result: { stopReason: 'end_turn' } });
      setTimeout(() => send({ method: ${JSON.stringify(method)}, params: { sessionId: 's1', status: ${JSON.stringify(status)} } }), ${afterMs});
    }
  } });
`;

async function compact(method: string, status: unknown, afterMs: number) {
  const session = createAcpSession({});
  const started = Date.now();
  try {
    await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent(method, status, afterMs)], cwd: process.cwd(), prompt: '/compact',
      environment: {}, permissionMode: 'ask', acp: { compactCommand: { prompt: '/compact', settledBy: method } },
    } as never);
    return Date.now() - started;
  } finally { await session.close(); }
}

describe('a compaction the agent runs after its answer', () => {
  it('ends when the agent says it completed, in Devin\'s and Kiro\'s shapes', async () => {
    expect(await compact('_cognition.ai/compaction', 'completed', 300)).toBeGreaterThanOrEqual(280);
    expect(await compact('_kiro.dev/compaction/status', { type: 'completed' }, 300)).toBeGreaterThanOrEqual(280);
  });

  it('fails the turn when the agent says the compaction failed', async () => {
    await expect(compact('_cognition.ai/compaction', 'failed', 50)).rejects.toThrow('fake reported that its compaction failed');
  });
});
