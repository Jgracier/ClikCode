/** MiniMax Code takes a message into a running turn through its own
 * `mcode/session/steer` (`{ sessionId, text }`; listed in initialize
 * `_meta['minimax-code/extensions'].methods`; read from mcode 0.5.10's source
 * -- it refuses, with an error, when no prompt turn of the session runs). */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { LiveTurnInputBroker } from '../../turn/live-input.js';

const agent = (refuse: boolean) => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const chunk = (text) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  let prompt; const steered = []; let finish;
  const end = () => { if (!prompt) return; const id = prompt; prompt = undefined; clearTimeout(finish); chunk(steered.length ? 'Answered: ' + steered.join('|') : 'Done.'); send({ id, result: { stopReason: 'end_turn' } }); };
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, _meta: { 'minimax-code/extensions': { version: 1, methods: ['mcode/session/steer'] } } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'mcode/session/steer') {
      if (${refuse}) { send({ id: m.id, error: { code: -32602, message: 'Steering requires an admitted, active ACP prompt Turn for this Session.' } }); continue; }
      steered.push(m.params.text); send({ id: m.id, result: { turnId: 't1', mode: 'steered' } }); setTimeout(end, 50);
    }
    else if (m.method === 'session/prompt') { prompt = m.id; chunk('Working. '); finish = setTimeout(end, 1500); }
  } });
`;

async function run(refuse: boolean) {
  const broker = new LiveTurnInputBroker({ steerTimeoutMs: 100 });
  const queue: string[] = [];
  broker.bindQueue(async (submission) => { queue.push(submission.id); });
  let typed: ReturnType<LiveTurnInputBroker['submit']> | undefined;
  let answer = '';
  const session = createAcpSession();
  try {
    await session.runTurn({
      binary: process.execPath, command: 'mcode', argv: ['-e', agent(refuse)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
      onSteerReady: (handler) => { broker.setSteerHandler(handler ? (text, _s, hold) => handler(text, hold) : undefined); },
      onResponseDelta: (delta) => { answer += delta; typed ??= broker.submit('and also this', 'm1'); },
    });
  } finally { await broker.settled(); await session.close(); }
  return { result: await typed, queue, answer };
}

describe('a message typed during a MiniMax Code turn', () => {
  it('goes into the running turn through mcode/session/steer and is answered in it', async () => {
    const out = await run(false);
    expect(out.result?.disposition).toBe('steered');
    expect(out.queue).toEqual([]);
    expect(out.answer).toContain('Answered: and also this');
  });

  it('is queued, not lost, when mcode refuses it', async () => {
    const out = await run(true);
    expect(out.result?.disposition).toBe('queued');
    expect(out.queue).toEqual(['m1']);
    expect(out.answer).toContain('Done.');
  });
});
