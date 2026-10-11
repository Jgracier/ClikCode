import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lifecycleLogPath } from './lifecycle-log.js';
import {
  beginTurnClock, endTurnClock, formatLatencyTable, markTurn, medianLatencyByHarness, turnLatency, turnsLatency,
} from './turn-latency.js';

const line = (turnId: string, mark: string, ms: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'turn.mark', t: '2026-10-11T00:00:00.000Z', pid: 1, role: 'worker', turnId, mark, ms, harness: 'claude', ...extra });

describe('turnLatency', () => {
  const lines = [
    line('t1', 'submit', 0), line('t1', 'first-paint', 31), line('t1', 'accepted', 40), line('t1', 'account', 52),
    line('t1', 'spawned', 60, { reused: true }), line('t1', 'ready', 88), line('t1', 'prompt-sent', 90),
    line('t1', 'first-byte', 700), line('t1', 'first-event', 705), line('t1', 'first-text', 900),
    line('t1', 'first-text-paint', 940), line('t1', 'end', 2000),
    line('t2', 'submit', 0), // another turn's line is not this one's
    JSON.stringify({ event: 'worker.turn.end', ms: 5 }),
  ];

  it('breaks one turn into the spans, the harness\'s own time apart from ClikCode\'s', () => {
    const turn = turnLatency(lines, 't1')!;
    expect(turn).toMatchObject({
      turnId: 't1', harness: 'claude', reused: true,
      submitToAccepted: 40, submitToSpawn: 60, spawnToReady: 28, readyToPromptSent: 2,
      promptToFirstByte: 610, readyToFirstByte: 612, firstByteToFirstEvent: 5, firstEventToFirstText: 195,
      submitToFirstPaint: 31, firstEventToFirstPaint: 235, firstTextToTextPaint: 40, submitToTextPaint: 940, total: 2000,
      vendorMs: 610, clikcodeMs: 330,
    });
  });

  it('leaves out a span whose marks the turn never reached', () => {
    const turn = turnLatency([line('t3', 'submit', 0), line('t3', 'accepted', 12)])!;
    expect(turn.submitToAccepted).toBe(12);
    expect(turn.vendorMs).toBeUndefined();
    expect(turn.spawnToReady).toBeUndefined();
  });

  it('groups a log into turns and takes the median per harness', () => {
    const more = [
      line('a', 'prompt-sent', 10, { harness: 'grok' }), line('a', 'first-byte', 110, { harness: 'grok' }), line('a', 'first-text', 150, { harness: 'grok' }),
      line('b', 'prompt-sent', 10, { harness: 'grok' }), line('b', 'first-byte', 310, { harness: 'grok' }), line('b', 'first-text', 400, { harness: 'grok' }),
      line('c', 'prompt-sent', 10, { harness: 'grok' }), line('c', 'first-byte', 210, { harness: 'grok' }), line('c', 'first-text', 250, { harness: 'grok' }),
    ];
    const turns = turnsLatency([...lines, ...more]);
    expect(turns.map((turn) => turn.turnId)).toEqual(['t1', 't2', 'a', 'b', 'c']);
    const grok = medianLatencyByHarness(turns).find((group) => group.harness === 'grok')!;
    expect(grok.turns).toBe(3);
    expect(grok.medians.vendorMs).toBe(200);
    expect(formatLatencyTable(turns)).toContain('grok');
  });
});

describe('turn marks', () => {
  let home: string;
  const saved = { home: process.env.CLIKCODE_HOME, enabled: process.env.CLIKCODE_LIFECYCLE_LOG };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clikcode-marks-'));
    process.env.CLIKCODE_HOME = home;
    process.env.CLIKCODE_LIFECYCLE_LOG = '1';
  });
  afterEach(() => {
    endTurnClock();
    for (const [key, value] of [['CLIKCODE_HOME', saved.home], ['CLIKCODE_LIFECYCLE_LOG', saved.enabled]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const records = (): Array<Record<string, unknown>> => (existsSync(lifecycleLogPath())
    ? readFileSync(lifecycleLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((text) => JSON.parse(text) as Record<string, unknown>) : []);

  it('writes one line per mark, with the turn id, the harness and ms since submit', () => {
    beginTurnClock({ turnId: 'turn-1', startedAt: Date.now() - 50, harness: 'grok' });
    markTurn('submit');
    markTurn('spawned', { reused: false });
    const [submit, spawned] = records();
    expect(submit).toMatchObject({ event: 'turn.mark', turnId: 'turn-1', mark: 'submit', harness: 'grok' });
    expect(submit!.ms).toBeGreaterThanOrEqual(50);
    expect(spawned).toMatchObject({ mark: 'spawned', reused: false });
  });

  it('writes nothing per delta: a streamed answer adds no lifecycle line after its marks', () => {
    beginTurnClock({ turnId: 'turn-2', harness: 'claude' });
    markTurn('prompt-sent');
    for (const mark of ['first-byte', 'first-event', 'first-text'] as const) markTurn(mark);
    const before = records().length;
    expect(before).toBe(4);
    // 5000 deltas, each of which asks for the marks again.
    for (let delta = 0; delta < 5000; delta += 1) {
      markTurn('first-byte');
      markTurn('first-event');
      markTurn('first-text');
    }
    expect(records().length).toBe(before);
  });

  it('does not take a handshake answer for the vendor\'s first byte', () => {
    beginTurnClock({ turnId: 'turn-3' });
    markTurn('first-byte');
    expect(records()).toEqual([]);
    markTurn('prompt-sent');
    markTurn('first-byte');
    expect(records().map((entry) => entry.mark)).toEqual(['prompt-sent', 'first-byte']);
  });

  it('is nothing when no turn is measured, and nothing when the home is gone', () => {
    markTurn('submit');
    expect(records()).toEqual([]);
    beginTurnClock({ turnId: 'turn-4' });
    rmSync(home, { recursive: true, force: true });
    expect(() => markTurn('submit')).not.toThrow();
    expect(existsSync(home)).toBe(false);
  });
});
