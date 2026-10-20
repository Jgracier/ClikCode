/** A cost an ACP agent reports is its PROCESS's running total (claude-agent-acp:
 * `usage_update.cost.amount = result.total_cost_usd`). A turn is charged what
 * the total grew by, measured per live process. Driven by a real child. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { ProcessCost } from '../protocol/running-cost.js';
import type { TurnUsage } from '../protocol/turn-usage.js';

/** `costs[n]` is what the nth prompt of THIS process reports; `onLoad` what a
 * session/load replays. A new child starts counting prompts again. */
function agent(costs: Array<number | undefined>, onLoad: number | undefined, perTurn?: number[]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const costs = ${JSON.stringify(costs)}; const onLoad = ${JSON.stringify(onLoad ?? null)}; const perTurn = ${JSON.stringify(perTurn ?? [])};
    const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
    const usage = (amount) => ({ sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount, currency: 'USD' } });
    let n = 0; let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/load') { if (onLoad !== null) update(usage(onLoad)); send({ id: m.id, result: {} }); }
      else if (m.method === 'session/prompt') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
        if (costs[n] !== undefined) update(usage(costs[n]));
        const own = perTurn[n]; n += 1;
        send({ id: m.id, result: { stopReason: 'end_turn', ...(own !== undefined ? { usage: { inputTokens: 10, outputTokens: 2, costUsd: own } } : {}) } });
      }
    } });
  `;
}

interface Run { costs: Array<number | undefined>; onLoad?: number; perTurn?: number[]; command?: string; resume?: boolean; env?: Record<string, string> }

async function turn(session: ReturnType<typeof createAcpSession>, run: Run): Promise<TurnUsage> {
  let merged: TurnUsage = {};
  await session.runTurn({
    binary: process.execPath, command: run.command ?? 'fake', argv: ['-e', agent(run.costs, run.onLoad, run.perTurn)], cwd: process.cwd(), prompt: 'go',
    environment: run.env ?? {}, permissionMode: 'ask', ...(run.resume ? { nativeSessionId: 's1' } : {}),
    onUsage: (usage) => { merged = { ...merged, ...usage }; },
  });
  return merged;
}

describe('a cost reported as a running total counts by what it grew', () => {
  it('the first turn of a process is its whole total, later turns what they added', async () => {
    const session = createAcpSession();
    const run: Run = { costs: [1.0, 1.5, 4.0] };
    try {
      expect((await turn(session, run)).costUsd).toBeCloseTo(1.0, 6);
      expect((await turn(session, run)).costUsd).toBeCloseTo(0.5, 6);
      expect((await turn(session, run)).costUsd).toBeCloseTo(2.5, 6);
    } finally { await session.close(); }
  });

  it('a total that falls means the process began again: the turn is the new total', async () => {
    const session = createAcpSession();
    const run: Run = { costs: [254, 286, 0.1, 0.4] };
    try {
      const spent: number[] = [];
      for (let index = 0; index < 4; index += 1) spent.push((await turn(session, run)).costUsd!);
      expect(spent[0]).toBeCloseTo(254, 6);
      expect(spent[1]).toBeCloseTo(32, 6);
      expect(spent[2]).toBeCloseTo(0.1, 6);
      expect(spent[3]).toBeCloseTo(0.3, 6);
    } finally { await session.close(); }
  });

  it('a respawned process starts fresh instead of subtracting from the old one', async () => {
    const session = createAcpSession();
    try {
      expect((await turn(session, { costs: [30, 31] })).costUsd).toBeCloseTo(30, 6);
      expect((await turn(session, { costs: [30, 31] })).costUsd).toBeCloseTo(1, 6);
      // A new child (its launch changed) resumes the conversation: its own count starts at 0.2.
      const second = await turn(session, { costs: [0.2, 0.5], resume: true, env: { RESPAWN: '1' } });
      expect(second.costUsd).toBeCloseTo(0.2, 6);
      expect((await turn(session, { costs: [0.2, 0.5], resume: true, env: { RESPAWN: '1' } })).costUsd).toBeCloseTo(0.3, 6);
    } finally { await session.close(); }
  });

  it('Claude resuming a conversation restores its cost: the first reading is where it stands, not the turn', async () => {
    const session = createAcpSession();
    try {
      const first = await turn(session, { command: 'claude', costs: [179.3, 179.9], resume: true });
      expect(first.costUsd ?? 0).toBeCloseTo(0, 6);
      expect((await turn(session, { command: 'claude', costs: [179.3, 179.9], resume: true })).costUsd).toBeCloseTo(0.6, 6);
    } finally { await session.close(); }
  });

  it('a total the load replays is the baseline whichever agent reports it', async () => {
    const session = createAcpSession();
    try {
      expect((await turn(session, { command: 'claude', costs: [200.4], onLoad: 200, resume: true })).costUsd).toBeCloseTo(0.4, 6);
    } finally { await session.close(); }
  });

  it('two accounts count apart', async () => {
    const [a, b] = [createAcpSession(), createAcpSession()];
    try {
      const one: Run = { costs: [10, 12], env: { ACCOUNT: 'a' } };
      const two: Run = { costs: [1, 1.5], env: { ACCOUNT: 'b' } };
      expect((await turn(a, one)).costUsd).toBeCloseTo(10, 6);
      expect((await turn(b, two)).costUsd).toBeCloseTo(1, 6);
      expect((await turn(a, one)).costUsd).toBeCloseTo(2, 6);
      expect((await turn(b, two)).costUsd).toBeCloseTo(0.5, 6);
    } finally { await Promise.all([a.close(), b.close()]); }
  });

  it('a vendor that reports each turn\'s own cost is left as reported', async () => {
    const session = createAcpSession();
    const run: Run = { costs: [], perTurn: [0.5, 0.5, 0.2] };
    try {
      expect((await turn(session, run)).costUsd).toBeCloseTo(0.5, 6);
      expect((await turn(session, run)).costUsd).toBeCloseTo(0.5, 6);
      expect((await turn(session, run)).costUsd).toBeCloseTo(0.2, 6);
    } finally { await session.close(); }
  });
});

describe('ProcessCost (one-shot CLI records)', () => {
  it('counts growth, resets on a fall, and a new process starts at zero', () => {
    const process1 = new ProcessCost();
    expect([process1.note(0.02), process1.note(0.05), process1.note(0.01)]).toEqual([0.02, expect.closeTo(0.05, 9), 0.01]);
    expect(new ProcessCost().note(7)).toBe(7);
  });
  it('a resumed Claude process measures from its first reading', () => {
    const resumed = new ProcessCost(true);
    expect([resumed.note(120), resumed.note(121.5)]).toEqual([0, 1.5]);
  });
});
