/** Claude Code's plan usage: its own /usage (free, no model call) and the
 * rate-limit windows a turn carries over ACP. */
import { describe, expect, it } from 'vitest';
import { claudeUsageCommandReading, usageWindowName } from './usage-reading.js';
import { createAcpSession } from '../transport/acp-client.js';
import type { UsageReading } from './usage-reading.js';

describe("Claude Code's /usage", () => {
  // `claude -p /usage --output-format json`, Claude Code 2.1.286 (result field).
  const text = 'You are currently using your subscription to power your Claude Code usage\n\n'
    + 'Current session: 3% used · resets Oct 1, 1:50pm (America/Denver)\n'
    + 'Current week (all models): 82% used · resets Oct 3, 1pm (America/Denver)\n'
    + 'Current week (Fable): 0% used · resets Oct 3, 1pm (America/Denver)\n';

  it('reads the session as the 5h window and the all-models week, with exact resets', () => {
    const reading = claudeUsageCommandReading(text, Date.parse('2026-10-01T15:00:00Z'));
    expect(reading?.label).toBe('5h 97% left · Weekly 18% left');
    // Denver is UTC-6 in October.
    expect(reading?.windows).toEqual([
      { name: '5h', usedPct: 3, resetsAt: '2026-10-01T19:50:00.000Z' },
      { name: 'weekly', usedPct: 82, resetsAt: '2026-10-03T19:00:00.000Z' },
    ]);
  });

  it('rolls a reset with no year into the next one when it would be in the past', () => {
    const reading = claudeUsageCommandReading('Current session: 10% used · resets Jan 2, 9am (UTC)', Date.parse('2026-12-31T12:00:00Z'));
    expect(reading?.windows[0]?.resetsAt).toBe('2027-01-02T09:00:00.000Z');
  });

  it('keeps a window whose zone it cannot read, without a reset', () => {
    expect(claudeUsageCommandReading('Current session: 10% used · resets Oct 1, 1pm (Nowhere/Here)')?.windows[0])
      .toEqual({ name: '5h', usedPct: 10 });
  });
});

describe('window names', () => {
  it('calls a 30-day window monthly, not 720h', () => {
    expect(usageWindowName(43_200)).toBe('monthly');
    expect(usageWindowName(10_080)).toBe('weekly');
    expect(usageWindowName(300)).toBe('5h');
  });
});

it("reads the rate limits claude-agent-acp forwards on a turn's usage_update", async () => {
  const info = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.04, resetsAt: 1790884200 }, seven_day: { utilization: 0.82, resetsAt: 1791054000 } } };
  const agent = `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } });
        update({ sessionUpdate: 'usage_update', used: 18000, size: 1000000, _meta: { '_claude/rateLimit': ${JSON.stringify(info)} } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    } });
  `;
  const session = createAcpSession();
  const readings: UsageReading[] = [];
  try {
    await session.runTurn({
      binary: process.execPath, command: 'claude', argv: ['-e', agent], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask', onQuotaReading: (reading) => readings.push(reading),
    });
  } finally { await session.close(); }
  expect(readings.map((reading) => reading.label)).toEqual(['5h 96% left · Weekly 18% left']);
});
