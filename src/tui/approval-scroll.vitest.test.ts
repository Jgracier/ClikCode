/** An approval waits for y or n; reading the conversation above it does not answer it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { SWIPE_BURST_MS } from './swipe-arrows.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('scroll keys while an approval is pending', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });
  afterEach(() => { vi.useRealTimers(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  function open(): { rl: TerminalHarnessPrompter; key: (k: string) => void; answered: () => boolean | undefined } {
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    for (let n = 0; n < 120; n += 1) rl.alternateTranscript.push(`row ${n}`);
    let result: boolean | undefined;
    void rl.approval('Run make?', 'make clean').then((answer) => { result = answer as boolean; });
    return { rl, key: (k) => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k), answered: () => result };
  }

  it('PageUp, arrows, Home and End scroll the transcript and answer nothing, inside the guard window and after it', async () => {
    const { rl, key, answered } = open();
    try {
      key('\u001b[5~');
      expect(rl.alternateScrollback).toBeGreaterThan(0);
      const after = rl.alternateScrollback;
      vi.advanceTimersByTime(1000);
      key('\u001b[A');
      // A lone arrow is held for the burst window before it counts as a key (swipe-arrows.ts); either way it scrolls here.
      vi.advanceTimersByTime(SWIPE_BURST_MS + 40);
      expect(rl.alternateScrollback).toBeGreaterThan(after);
      key('\u0001');
      expect(rl.alternateScrollback).toBeGreaterThan(after);
      key('\u0005');
      expect(rl.alternateScrollback).toBe(0);
      await Promise.resolve();
      expect(answered()).toBeUndefined();
      // The answer keys are unchanged: n denies after the guard.
      key('n');
      await Promise.resolve(); await Promise.resolve();
      expect(answered()).toBe(false);
    } finally { rl.close(); }
  });
});
