/** A terminal that covers its top rows (the phone: status bar, Dynamic Island, tabs): the conversation is drawn under them, all the
 * way up, and scrolling back brings its first line to rest below them. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardCapacity } from './conversation-board.js';
import { KEEP_STDIN_FLOWING, TerminalInputDecoder } from './input-decoder.js';
import { asksCoveredTop, coveredTopKnown, noteProbeReply, terminalFacts, uncoveredRows } from './probe.js';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = { id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never;

describe('a terminal that covers its top rows', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = ((_chunk: unknown, ...rest: unknown[]) => {
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
    terminalFacts.coveredTopRows = 0;
  });
  afterEach(() => {
    terminalFacts.coveredTopRows = 0;
    vi.useRealTimers();
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  function conversation(rows: number): TerminalHarnessPrompter {
    const rl = new TerminalHarnessPrompter();
    rl.render(session);
    for (let n = 0; n < rows; n += 1) rl.alternateTranscript.push(`row ${n}`);
    rl.flushPaint();
    return rl;
  }
  const first = (rl: TerminalHarnessPrompter): number => rl.alternatePrevious.findIndex((row) => row.includes('row 0'));

  it('its answer is the terminal talking, never a key; only the phone page is asked', () => {
    expect(noteProbeReply('\u001b]7701;4\u001b\\')).toBe(true);
    expect(terminalFacts.coveredTopRows).toBe(4);
    expect(noteProbeReply('\u001b]7701;6\u0007')).toBe(true);
    expect(terminalFacts.coveredTopRows).toBe(6);
    expect(noteProbeReply('\u001b]11;rgb:0000/0000/0000\u001b\\')).toBe(false);
    const keys: string[] = [];
    const decoder = new TerminalInputDecoder();
    for (const key of decoder.push('a\u001b]7701;3\u001b\\b')) keys.push(key);
    expect(keys).toEqual(['a', '\u001b]7701;3\u001b\\', 'b']); // one whole token for the listener to take, which it does (above)
    expect(asksCoveredTop({ CLIKDEPLOY_CLIENT: 'mobile' })).toBe(true);
    expect(asksCoveredTop({})).toBe(false);
  });

  it('anywhere but its very start the conversation runs all the way up: the covered rows are drawn, not left empty', () => {
    terminalFacts.coveredTopRows = 4;
    const rl = conversation(120);
    try {
      rl.scrollTranscript(10);
      rl.flushPaint();
      expect(rl.alternatePrevious.slice(0, 4).every((row) => /^row \d+/.test(row))).toBe(true);
    } finally { rl.close(); }
  });

  it('scrolled all the way back, the first line rests just below the covered rows', () => {
    terminalFacts.coveredTopRows = 4;
    const rl = conversation(120);
    try {
      rl.scrollTranscript(100_000);
      rl.flushPaint();
      expect(first(rl)).toBe(4);
      expect(rl.alternatePrevious.slice(0, 4).every((row) => row.trim() === '')).toBe(true);
      // And no further: another swipe back does not move it.
      expect(rl.scrollTranscript(10)).toBe(false);
    } finally { rl.close(); }
  });

  it('a terminal that covers nothing is as it was: the first line reaches the top row', () => {
    const rl = conversation(120);
    try {
      rl.scrollTranscript(100_000);
      rl.flushPaint();
      expect(first(rl)).toBe(0);
    } finally { rl.close(); }
  });

  it('a conversation that just fits can still bring its first line down from under the cover', () => {
    terminalFacts.coveredTopRows = 4;
    const rl = conversation(0);
    try {
      const above = rl.alternateAbove;
      for (let n = 0; n < above - 1; n += 1) rl.alternateTranscript.push(`row ${n}`); // fills the view but for one row: its top is under the cover
      rl.flushPaint();
      expect(first(rl)).toBeLessThan(4);
      rl.scrollTranscript(100_000);
      rl.flushPaint();
      expect(first(rl)).toBe(4);
    } finally { rl.close(); }
  });

  it('everything but the conversation is laid out in the rows left: the chat history, a list, the composer\'s block', () => {
    terminalFacts.coveredTopRows = 4;
    expect(uncoveredRows(30)).toBe(26);
    expect(boardCapacity(uncoveredRows(30))).toBe(boardCapacity(30) - 4);
    terminalFacts.coveredTopRows = 0;
    expect(uncoveredRows(30)).toBe(30);
  });

  it('the chat history is a screen of its own: the rows it leaves at the top are empty, not the end of the last conversation', () => {
    terminalFacts.coveredTopRows = 4;
    const rl = conversation(120);
    try {
      rl.scrollTranscript(10);
      rl.flushPaint();
      expect(rl.alternatePrevious.some((row) => /^row \d+/.test(row))).toBe(true);
      rl.surface = 'history';
      rl.paintCurrent();
      expect(rl.alternatePrevious.some((row) => /^row \d+/.test(row))).toBe(false);
      expect(rl.alternatePrevious.slice(0, 4).every((row) => row.trim() === '')).toBe(true);
    } finally { rl.close(); }
  });

  it('the first frame on the phone waits for its answer, briefly: never drawn twice, never held for long', async () => {
    vi.useRealTimers();
    const env = process.env.CLIKDEPLOY_CLIENT;
    process.env.CLIKDEPLOY_CLIENT = 'mobile';
    try {
      const started = Date.now();
      const waiting = coveredTopKnown(1000);
      setTimeout(() => noteProbeReply('\u001b]7701;5\u001b\\'), 20);
      await waiting;
      expect(Date.now() - started).toBeLessThan(500);
      expect(terminalFacts.coveredTopRows).toBe(5);
      const silent = Date.now();
      await coveredTopKnown(60); // a terminal that never answers costs at most the bound
      expect(Date.now() - silent).toBeLessThan(400);
    } finally {
      if (env === undefined) delete process.env.CLIKDEPLOY_CLIENT; else process.env.CLIKDEPLOY_CLIENT = env;
    }
  });
});
