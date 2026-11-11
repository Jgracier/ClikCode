import { afterEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_DUMP_ROWS, takeHistoryDump } from './prompter/history-dump.js';
import { historyDump, historyDumpSequence, enterAlternateScreenSequence, dumpChunks, HISTORY_DUMP_CHUNK_BYTES } from './restore.js';
import type { TerminalHarnessPrompter } from './prompter.js';

type Fake = { scrollWindow: { source: undefined } };
const dump = (f: Fake): string => takeHistoryDump.call(f as unknown as TerminalHarnessPrompter);
const rowsOf = (text: string): string[] => text.replaceAll('\u001b[?7h', '').split('\u001b[0m\r\n').slice(0, -1);

describe('the conversation written into the normal screen when the alternate screen is left', () => {
  afterEach(() => { historyDump.source = undefined; historyDump.suppressed = false; vi.unstubAllEnvs(); });

  it('writes nothing before a conversation was drawn (the dump of a real one is in full-history.vitest.test.ts)', () => {
    expect(HISTORY_DUMP_ROWS).toBe(20000);
    expect(dump({ scrollWindow: { source: undefined } })).toBe('');
  });

  it('is what the terminal gets after the alternate screen is left, once, and not at all when a hand-over suppressed it', () => {
    vi.stubEnv('CLIKCODE_INLINE', '');
    let pending = 'hello\u001b[0m\r\n';
    historyDump.source = () => { const text = pending; pending = ''; return text; };
    expect(rowsOf(historyDumpSequence())).toEqual(['hello']);
    expect(historyDumpSequence()).toBe('');
    pending = 'again\u001b[0m\r\n';
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

  it('is written in chunks that end on a row, and put back together are the dump', () => {
    const text = Array.from({ length: 30000 }, (_, n) => `row number ${n}\u001b[0m\r\n`).join('');
    const chunks = dumpChunks(text);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) { expect(chunk.endsWith('\n')).toBe(true); expect(chunk.length).toBeLessThan(HISTORY_DUMP_CHUNK_BYTES + 100); }
    expect(dumpChunks('')).toEqual([]);
  });
});
