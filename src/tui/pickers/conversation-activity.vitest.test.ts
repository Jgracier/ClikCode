import { describe, expect, it } from 'vitest';
import { subagentOptions, workingDetail } from './conversation-activity';
import { turnPace } from '../../harness/protocol/turn-pace';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('turn pace', () => {
  it('flows while the turn is still doing things, however long it has run', () => {
    expect(turnPace(ago(30_000), NOW)).toBe('flowing');
  });

  it('slows after three quiet minutes and is stuck after fifteen', () => {
    expect(turnPace(ago(4 * 60_000), NOW)).toBe('slowing');
    expect(turnPace(ago(16 * 60_000), NOW)).toBe('stuck');
  });
});

describe('a working conversation row', () => {
  const pending = {
    prompt: 'go', startedAt: ago(10 * 60_000), updatedAt: ago(20 * 60_000), outputStarted: true,
    subagents: [
      { id: 'a', label: 'Agent(Explore)', startedAt: ago(5 * 60_000), step: 'Read(src/a.ts)', stepAt: ago(10_000) },
      { id: 'b', label: 'Agent(Review)', startedAt: ago(60_000) },
    ],
  };

  it('says how long, that it has gone quiet, and how many sub-agents it has out', () => {
    expect(strip(workingDetail(pending, NOW))).toBe('· working 10m · stuck · 2 subagents ←');
  });

  it('lists each sub-agent with its step, and each opens the conversation', () => {
    const rows = subagentOptions(pending, 'conversation-1', NOW);
    expect(rows.map((row) => [strip(row.label), strip(row.detail ?? ''), row.value])).toEqual([
      ['● Agent(Explore)', '· Read(src/a.ts) · 5m', 'conversation-1'],
      ['● Agent(Review)', '· starting · 1m', 'conversation-1'],
    ]);
  });
});
