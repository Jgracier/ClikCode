/** Rows of the running turn that are not a tool call: a note, a decision. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('a note written while the turn runs', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function window(): { rl: TerminalHarnessPrompter; screen: () => string } {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    return { rl, screen: () => strip(written.join('')) };
  }

  it('is drawn at its place in the live turn, not lost for want of an event', () => {
    const { rl, screen } = window();
    try {
      rl.response('First paragraph of the answer.\n\n');
      rl.activity('Switched to the backup account');
      rl.response('Second paragraph of the answer.\n\n');
      vi.advanceTimersByTime(300);
      const text = screen();
      expect(text).toContain('Switched to the backup account');
      expect(text.lastIndexOf('First paragraph')).toBeLessThan(text.lastIndexOf('Switched to the backup account'));
    } finally { rl.close(); }
  });
});

describe('the background terminals indicator (standard section 10)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function window(rows = 30): { rl: TerminalHarnessPrompter; screen: () => string; since: () => string } {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    let mark = 0;
    return { rl, screen: () => strip(written.join('')), since: () => { const text = strip(written.slice(mark).join('')); mark = written.length; return text; } };
  }

  it('says N background terminals running under the status, singular for one, and goes at zero', () => {
    const { rl, screen, since } = window();
    try {
      vi.advanceTimersByTime(300);
      since();
      rl.setBackgroundWork({ terminals: 2 });
      vi.advanceTimersByTime(300);
      expect(since()).toContain('2 background terminals running');
      rl.setBackgroundWork({ terminals: 1, agents: 1 });
      vi.advanceTimersByTime(300);
      expect(since()).toContain('1 background terminal running');
      rl.setBackgroundWork({ agents: 1 });
      vi.advanceTimersByTime(300);
      const after = since();
      expect(after).not.toContain('background terminal');
      expect(screen()).toContain('2 background terminals running');
    } finally { rl.close(); }
  });

  it('is not drawn when nothing runs, and not on a terminal too short to spare the row', () => {
    const idle = window();
    try {
      vi.advanceTimersByTime(300);
      expect(idle.screen()).not.toContain('background terminal');
    } finally { idle.rl.close(); }
    const short = window(8);
    try {
      short.rl.setBackgroundWork({ terminals: 3 });
      vi.advanceTimersByTime(300);
      expect(short.screen()).not.toContain('background terminal');
    } finally { short.rl.close(); }
  });
});

describe('the token meter of a running turn', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  // MEASURED 2026-10-11: a window that joined a turn showed a number that did not move however much
  // was written, because a vendor's early, small reading outranked the written length.
  it('is not held on a vendor reading taken once, early, nor by reasoning it cannot see', () => {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    try {
      rl.setTurnUsage({ output: 8 });
      rl.response('word '.repeat(2000));
      vi.advanceTimersByTime(3000);
      const text = strip(written.join(''));
      const counts = [...text.matchAll(/↓ ([0-9.]+)k? tokens/g)].map((match) => match[0]);
      // 10000 chars is 2500 tokens: shown as 2.5k, not 8.
      expect(counts.at(-1)).toBe('↓ 2.5k tokens');
    } finally { rl.close(); }
  });
});
