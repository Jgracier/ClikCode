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

describe('running steps stay above the status line', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('is one animated agent row with its latest call under it, whether or not it is clicked', () => {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    const keys = rl as unknown as { handleScrollKey(key: string): boolean };
    const click = (): void => {
      keys.handleScrollKey('\u001b[<0;4;2M');
      keys.handleScrollKey('\u001b[<0;4;2m');
      vi.advanceTimersByTime(50);
    };
    const agentRow = (text: string): string[] => [...text.matchAll(/(\S\S) {2}agent Task\(explore\)/g)].map((match) => match[1]!);
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
      rl.response(`${'The answer keeps going. '.repeat(40)}\n\n`);
      rl.activityEvent({ kind: 'tool-start', id: 'a', label: 'Task(explore)', agent: true });
      rl.activityEvent({ kind: 'tool-start', id: 'c', parentId: 'a', label: 'Grep(charge)' });
      vi.advanceTimersByTime(300);
      const before = strip(written.join(''));
      // One row for the agent, its call under it with the static tool mark and the count.
      expect(before).toContain('‣ Grep(charge) · 1 tool use');
      expect(before).not.toContain('click');
      // The ring spins: the glyph changes from frame to frame.
      expect(new Set(agentRow(before)).size).toBeGreaterThan(1);
      written.length = 0;
      click();
      vi.advanceTimersByTime(300);
      const after = strip(written.join(''));
      // Clicking changes nothing: the row stays, and keeps animating.
      expect(after).toContain('agent Task(explore)');
      expect(after).not.toContain('click');
    } finally { rl.close(); }
  });
});

describe('the running turn carries no token meter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  // MEASURED 2026-10-11: a window that joined a turn showed a number that did not move however much
  // was written, because a vendor's early, small reading outranked the written length.
  it('says no token count however much is written (tokens stay in /usage)', () => {
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
      expect(text).not.toMatch(/↓ [0-9.]+k? tokens/);
    } finally { rl.close(); }
  });
});
