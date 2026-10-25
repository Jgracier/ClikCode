/** Rows of the running turn that are not a tool call: a note, a decision. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stdin } from 'node:process';
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

  it('keeps each named background agent above the idle composer until it finishes', () => {
    const { rl, since } = window();
    try {
      since();
      rl.setBackgroundWork({ agents: 2, agentTasks: [
        { id: 'a', label: 'Review auth' }, { id: 'b', label: 'Run tests' },
      ] });
      vi.advanceTimersByTime(300);
      expect(since()).toContain('Review auth');
      rl.stopWaiting();
      vi.advanceTimersByTime(300);
      expect(since()).toContain('Run tests');
      rl.setBackgroundWork(undefined);
      vi.advanceTimersByTime(300);
      expect(rl.backgroundWork).toBeUndefined();
    } finally { rl.close(); }
  });

  it('history owns its frame even while the previous chat still has background work', async () => {
    const { rl, since } = window();
    try {
      rl.activityEvent({ kind: 'tool-start', label: '$ old-child-command', id: 'child', parentId: 'a' });
      expect(rl.liveChildren.latest('a')).toBe('$ old-child-command');
      rl.setBackgroundWork({ agents: 1, agentTasks: [{ id: 'a', label: 'previous-chat-agent' }] });
      rl.leaveTurn();
      since();
      const board = rl.board({ conversations: () => [{ value: 's', label: 'History conversation' }], commands: [] });
      expect(rl.surface).toBe('history');
      // Work can change while a list is open. It belongs to the chat, including
      // on a resize, rather than becoming a band on the history screen.
      rl.setBackgroundWork({ agents: 1, agentTasks: [{ id: 'a', label: 'updated-chat-agent' }] });
      rl.setPlan([{ content: 'previous-chat-checklist', status: 'in_progress' }]);
      rl.requestRedraw('repair');
      rl.repaint();
      vi.advanceTimersByTime(300);
      const history = since();
      expect(history).toContain('History conversation');
      expect(history).not.toContain('previous-chat-agent');
      expect(history).not.toContain('updated-chat-agent');
      expect(history).not.toContain('previous-chat-checklist');
      stdin.emit('data', '\u001b[D');
      await board;
      expect(rl.surface).toBe('conversation');
      rl.requestRedraw('repair');
      rl.repaint();
      vi.advanceTimersByTime(300);
      expect(since()).toContain('updated-chat-agent');
      rl.render({ ...rl.currentSession!, id: 'other-chat' }, undefined, { running: false });
      expect(rl.backgroundWork).toBeUndefined();
      expect(rl.planEntries).toEqual([]);
      expect(rl.planHold).toBe(0);
      expect(rl.liveChildren.latest('a')).toBeUndefined();
    } finally { rl.close(); }
  });

  it('is not drawn when nothing runs, and takes no row of its own on a short terminal', () => {
    const idle = window();
    try {
      vi.advanceTimersByTime(300);
      expect(idle.screen()).not.toContain('background terminal');
    } finally { idle.rl.close(); }
    const short = window(8);
    try {
      short.rl.setBackgroundWork({ terminals: 3 });
      vi.advanceTimersByTime(300);
      // It rides the status line (or the blank row over it): no row is added.
      expect(short.screen()).toContain('3 background terminals running');
      expect(short.screen()).not.toMatch(/\[9;1H[^\u001b]*background terminal/);
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

  it('keeps one animated agent row above the composer with its latest call', () => {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    const agentRow = (text: string): string[] => [...text.matchAll(/([\u2800-\u28ff]{2}) {2}Task\(explore\)/g)].map((match) => match[1]!);
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
      rl.response(`${'The answer keeps going. '.repeat(40)}\n\n`);
      rl.activityEvent({ kind: 'tool-start', id: 'a', label: 'Task(explore)', agent: true });
      rl.activityEvent({ kind: 'tool-start', id: 'c', parentId: 'a', label: 'Grep(charge)' });
      vi.advanceTimersByTime(300);
      const before = strip(written.join(''));
      // The child is in the agent's fixed row, with no second tool row.
      expect(before).toContain('Task(explore)  ·  Grep(charge)');
      expect(before).not.toContain('‣ Grep(charge)');
      expect(before).not.toContain('click');
      // The ring spins: the glyph changes from frame to frame.
      expect(new Set(agentRow(before)).size).toBeGreaterThan(1);
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
