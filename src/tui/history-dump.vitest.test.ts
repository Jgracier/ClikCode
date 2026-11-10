import { afterEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_DUMP_ROWS, takeHistoryDump } from './prompter/history-dump.js';
import { historyDump, historyDumpSequence, enterAlternateScreenSequence } from './restore.js';
import type { TerminalHarnessPrompter } from './prompter.js';

type Fake = { alternateTranscript: string[]; pendingFinished: string[]; alternateTrimmed: number; dumpedThrough: number | undefined; scrollWindow: { source: undefined } };
const fake = (rows: string[], extra: Partial<Fake> = {}): Fake => ({ alternateTranscript: rows, pendingFinished: [], alternateTrimmed: 0, dumpedThrough: undefined, scrollWindow: { source: undefined }, ...extra });
const dump = (f: Fake): string => takeHistoryDump.call(f as unknown as TerminalHarnessPrompter);
const rowsOf = (text: string): string[] => text.replaceAll('\u001b[?7h', '').split('\u001b[0m\r\n').slice(0, -1);

/** Rows handed in directly, with no conversation behind them (the dump of a real conversation is in full-history.vitest.test.ts). */
describe('the conversation written into the normal screen when the alternate screen is left', () => {
  afterEach(() => { historyDump.source = undefined; historyDump.suppressed = false; vi.unstubAllEnvs(); });

  it('writes every retired row once, in order, each closed with a reset and a line break, autowrap on', () => {
    const f = fake(['one', 'two', 'three']);
    const text = dump(f);
    expect(text.startsWith('\u001b[?7h')).toBe(true);
    expect(rowsOf(text)).toEqual(['one', 'two', 'three']);
  });

  it('includes rows still waiting to be flushed, and a second dump writes only what is new (suspend, then exit)', () => {
    const f = fake(['one', 'two'], { pendingFinished: ['two-and-a-half'] });
    expect(rowsOf(dump(f))).toEqual(['one', 'two', 'two-and-a-half']);
    expect(dump(f)).toBe('');
    f.alternateTranscript.push('two-and-a-half', 'three');
    f.pendingFinished = [];
    expect(rowsOf(dump(f))).toEqual(['three']);
  });

  it('follows rows trimmed off the front by their numbers, so nothing is written twice or skipped', () => {
    const f = fake(['a', 'b', 'c', 'd']);
    dump(f);
    f.alternateTranscript.splice(0, 2); f.alternateTrimmed += 2;
    f.alternateTranscript.push('e');
    expect(rowsOf(dump(f))).toEqual(['e']);
  });

  it('writes the whole new text after the conversation was rewritten (a new width, /clear, another conversation)', () => {
    const f = fake(['a', 'b']);
    dump(f);
    f.dumpedThrough = undefined; // what clearTranscript does
    f.alternateTrimmed += f.alternateTranscript.length; f.alternateTranscript = ['x', 'y', 'z'];
    expect(rowsOf(dump(f))).toEqual(['x', 'y', 'z']);
  });

  it('is bounded at 20000 rows, newest rows kept, and says how many earlier ones it left out', () => {
    expect(HISTORY_DUMP_ROWS).toBe(20000);
    const rows = Array.from({ length: HISTORY_DUMP_ROWS + 5 }, (_, n) => `r${n}`);
    const out = rowsOf(dump(fake(rows)));
    expect(out).toHaveLength(HISTORY_DUMP_ROWS + 1);
    expect(out[0]).toContain('5 earlier rows not shown');
    expect(out[1]).toBe('r5');
    expect(out.at(-1)).toBe(`r${HISTORY_DUMP_ROWS + 4}`);
  });

  it('writes nothing for an empty conversation', () => {
    expect(dump(fake([]))).toBe('');
  });

  it('is what the terminal gets after the alternate screen is left, once, and not at all when a hand-over suppressed it', () => {
    vi.stubEnv('CLIKCODE_INLINE', '');
    const f = fake(['hello']);
    historyDump.source = () => dump(f);
    expect(rowsOf(historyDumpSequence())).toEqual(['hello']);
    expect(historyDumpSequence()).toBe('');
    f.alternateTranscript.push('again');
    historyDump.suppressed = true;
    expect(historyDumpSequence()).toBe('');
  });

  it('is never written in inline mode: the conversation is in the scrollback already', () => {
    vi.stubEnv('CLIKCODE_INLINE', '1');
    historyDump.source = () => 'x';
    expect(historyDumpSequence()).toBe('');
  });

  it('under GNU screen (which swallows the alternate screen) erases what was drawn first, without ESC[2J or ESC[3J', () => {
    vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', '1.pts-0'); vi.stubEnv('TMUX', '');
    historyDump.source = () => 'rows\r\n';
    const out = historyDumpSequence();
    expect(out.endsWith('rows\r\n')).toBe(true);
    expect(out).not.toMatch(/\u001b\[[23]J/);
    expect(out.length).toBeGreaterThan('rows\r\n'.length);
    expect(enterAlternateScreenSequence()).not.toMatch(/\u001b\[[23]J/);
    expect(enterAlternateScreenSequence()).toContain('\r\n\r\n');
  });

  it('never wipes the user\'s saved lines to take the screen: no ESC[3J on the way in', () => {
    vi.stubEnv('STY', ''); 
    expect(enterAlternateScreenSequence()).not.toContain('[3J');
    expect(enterAlternateScreenSequence().startsWith('\u001b[?1049h')).toBe(true);
  });
});
