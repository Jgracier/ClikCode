/** A build reload (exec) hands the terminal to a new process that may draw with the other screen model; the new process makes the
 * terminal match its own. The owner's symptom was another conversation above the right one after an inline window re-exec'd into
 * a full-screen build. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { parseReexecHandover, reexecHandover, REEXEC_TERMINAL_ENV, historyDump } from './restore.js';
import { TestScreen } from './inline-screen.vitest-helper.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const ROWS = 8;
const oldTranscript = Array.from({ length: 20 }, (_, n) => `OLD conversation row ${n}`);

/** An inline predecessor already printed its conversation into the normal screen; then the new process starts. */
function startOver(predecessor: 'inline' | 'alt', handover: string | undefined, env: Record<string, string>): { term: TestScreen; writes: string[] } {
  const term = new TestScreen(ROWS, 60);
  const writes: string[] = [];
  Object.assign(process.stdout, { isTTY: true, columns: 60, rows: ROWS });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    writes.push(String(chunk)); term.write(String(chunk));
    for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
    return true;
  }) as typeof process.stdout.write;
  if (predecessor === 'inline') term.write(`${oldTranscript.join('\r\n')}\r\n`);
  else { term.write('shell prompt\r\n'); term.write('\u001b[?1049h'); term.write('OLD alt frame'); }
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  if (handover !== undefined) vi.stubEnv(REEXEC_TERMINAL_ENV, handover);
  writes.length = 0;
  const rl = new TerminalHarnessPrompter();
  rl.close = () => undefined;
  void rl;
  return { term, writes };
}

describe('the new process reconciles the terminal with its own screen model', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
    historyDump.source = undefined; historyDump.suppressed = false;
  });
  const full = { CLIKCODE_INLINE: '', CLIKDEPLOY_CLIENT: 'mobile', STY: '', TMUX: '' };
  const inline = { CLIKCODE_INLINE: '1', CLIKDEPLOY_CLIENT: '', STY: '', TMUX: '' };
  const nothingOld = (term: TestScreen): void => {
    expect([...term.scrollback, ...term.screen(), ...term.mainScreen()].filter((r) => r.includes('OLD'))).toEqual([]);
  };

  it('inline predecessor -> full-screen (handover inline): no old row in the scrollback or on any screen, alternate screen up', () => {
    const { term } = startOver('inline', 'inline', full);
    nothingOld(term);
    expect(term.scrollback).toEqual([]);
    expect(term.alt).toBe(true);
  });

  it('the ambiguous handover 1 into full-screen gives the same result', () => {
    const { term } = startOver('inline', '1', full);
    nothingOld(term);
    expect(term.alt).toBe(true);
  });

  it('alternate -> alternate (handover alt): scrollback and screen untouched, nothing written to clear or enter', () => {
    const { term, writes } = startOver('alt', 'alt', full);
    expect(term.alt).toBe(true);
    expect(term.entered).toBe(1);
    expect(term.mainScreen()[0]).toBe('shell prompt');
    expect(writes.join('')).not.toMatch(/\u001b\[[23]J|\u001b\[\?1049[hl]/);
  });

  it('full-screen predecessor -> inline: the alternate screen is left, then the inline clear', () => {
    const { term, writes } = startOver('alt', 'alt', inline);
    expect(term.alt).toBe(false);
    const all = writes.join('');
    expect(all.indexOf('\u001b[?1049l')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('\u001b[?1049l')).toBeLessThan(all.indexOf('\u001b[3J'));
  });

  it('a fresh start (no handover) takes the alternate screen as before', () => {
    const { term } = startOver('alt', undefined, full);
    expect(term.alt).toBe(true);
  });

  it('hands over the model it is on, and reads old and unknown values', () => {
    expect(reexecHandover({ CLIKCODE_INLINE: '1' })).toBe('inline');
    expect(reexecHandover({ CLIKCODE_INLINE: '1', CLIKDEPLOY_CLIENT: 'mobile' })).toBe('alt');
    expect(reexecHandover({})).toBe('alt');
    expect(['inline', 'alt', '1', '', 'x'].map(parseReexecHandover)).toEqual(['inline', 'alt', '1', undefined, undefined]);
  });
});
