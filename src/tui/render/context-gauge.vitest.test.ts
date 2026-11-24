import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { noteCompactAt } from '../../turn/compaction.js';
import { tuneKey } from '../../turn/context-tune.js';
import { contextGaugeLabel } from './context-gauge.js';
import { paintUsageRule } from './waiting.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const session = (over: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', nativeHarness: 'claude', model: 'claude-haiku-5-5',
  lastUsage: { contextUsed: 41_000, contextWindow: 1_000_000, at: '2026-11-24T00:00:00Z' },
  ...over,
} as HarnessSession);

let home: string;
const previous = process.env.CLIKCODE_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-gauge-')); process.env.CLIKCODE_HOME = home; });
afterEach(() => {
  noteCompactAt(undefined);
  if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

describe('contextGaugeLabel', () => {
  it('auto with no tuning yet: the 100k starting level', () => {
    noteCompactAt({ compactAt: 'auto' });
    expect(contextGaugeLabel(session())).toBe('41k/100k');
  });

  it('auto follows the level the model was tuned to', () => {
    noteCompactAt({ compactAt: 'auto' });
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(join(home, 'cache', 'context-tune.json'), JSON.stringify({ v: 1, models: { [tuneKey('claude', 'claude-haiku-5-5')]: { level: 60_000, full: {}, cut: {}, log: [] } } }));
    expect(contextGaugeLabel(session())).toBe('41k/60k');
  });

  it('a fixed setting is the denominator', () => {
    noteCompactAt({ compactAt: 150_000 });
    expect(contextGaugeLabel(session())).toBe('41k/150k');
  });

  it('off: the model window', () => {
    noteCompactAt({ compactAt: 'off' });
    expect(contextGaugeLabel(session())).toBe('41k/1M');
  });

  it('nothing measured yet: no gauge', () => {
    expect(contextGaugeLabel(session({ lastUsage: undefined }))).toBeUndefined();
  });
});

describe('paintUsageRule with a gauge', () => {
  it('draws the gauge left of the spend', () => {
    expect(strip(paintUsageRule(60, '5h 96% left', '41k/100k'))).toMatch(/41k\/100k · 5h 96% left$/);
  });
  it('gauge alone, spend alone', () => {
    expect(strip(paintUsageRule(40, undefined, '41k/100k'))).toMatch(/41k\/100k$/);
    expect(strip(paintUsageRule(40, '5h 96% left'))).toMatch(/5h 96% left$/);
  });
});
