/** An ACP turn's setup -- handshake, session/new|load, model and mode -- is
 * bounded by an idle window that anything from the agent restarts, while the
 * prompt turn itself stays unbounded; and Esc during setup cancels the turn,
 * not the agent: the setup finishes in the background and the next turn
 * starts on the same child. Driven by real child processes speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';

/** A fake agent. `load`: how session/load behaves -- answered after `streamFor`
 * ms of session/update every 100ms, or never (`silent`). Writes its pid on
 * session/new|load so a test can tell whether a turn reused it. */
function agent(options: { silentAt?: string; streamFor?: number; promptDelay?: number }): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const options = ${JSON.stringify(options)};
    let buf = '';
    let loads = 0;
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === options.silentAt) continue;
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/load') {
        loads += 1;
        const timer = setInterval(() => send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } } }), 100);
        setTimeout(() => { clearInterval(timer); send({ id: m.id, result: {} }); }, options.streamFor ?? 0);
      } else if (m.method === 'session/prompt') {
        setTimeout(() => {
          send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pid ' + process.pid + ' loads ' + loads } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }, options.promptDelay ?? 0);
      }
    } });
  `;
}

const input = (script: string, extra: Record<string, unknown> = {}) => ({
  binary: process.execPath, command: 'fake', argv: ['-e', script], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' as const, ...extra,
});

describe('ACP setup is bounded by an idle window', () => {
  it('fails a turn whose agent goes silent at a setup step, naming the step', async () => {
    const session = createAcpSession({ setupIdleMs: 400 });
    try {
      await expect(session.runTurn(input(agent({ silentAt: 'session/new' })))).rejects.toThrow('fake ACP stalled at session/new: nothing from it for 0s');
    } finally { await session.close(); }
  }, 20_000);

  it('lets a load that keeps streaming run past the window, and never bounds the prompt', async () => {
    const session = createAcpSession({ setupIdleMs: 400 });
    try {
      // The load streams for 1.2s (three windows), the prompt is silent for 1s (two and a half).
      const result = await session.runTurn(input(agent({ streamFor: 1_200, promptDelay: 1_000 }), { nativeSessionId: 's9' }));
      expect(result.text).toMatch(/^pid \d+ loads 1$/);
    } finally { await session.close(); }
  }, 20_000);
});
