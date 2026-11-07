import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stdout } from 'node:process';
import { flushInlineFrame } from './prompter/frame-flush.js';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode, setPhoneVisibleRows } from './inline.js';
import { asciiMode, foldAscii } from './glyphs.js';
import { TestScreen } from './inline-screen.vitest-helper.js';

const COLS = 100;
const rule = '─'.repeat(COLS - 1);
function live(text: string): string[] { return ['', `  esc stop`, rule, `> ${text}`, rule, '  claude  •  opus  •  ~/projects']; }

let writes: string[];
let host: Record<string, unknown>;
function frame(text: string, finished: string[] = [], rows = live(text)): string {
  writes.length = 0;
  flushInlineFrame.call(host as never, finished, { live: rows, cursorRow: 3, cursorColumn: 3 + text.length, hideCursor: false });
  return writes.join('');
}

describe('inline frame writer', () => {
  beforeEach(() => {
    writes = [];
    Object.defineProperty(stdout, 'columns', { value: COLS, configurable: true });
    vi.spyOn(stdout, 'write').mockImplementation(((chunk: string, cb?: () => void) => { writes.push(String(chunk)); cb?.(); return true; }) as never);
    eraseInlineBlock();
    inlineBlock.clearNext = false;
    host = {
      alternateTranscript: [], alternateTrimmed: 0, viewportRows: () => 40, pickerOverlay: [], chromeRows: 0,
      pendingSignals: '', frameInFlight: false, closed: false, suspended: false, flushFrame: () => {},
    };
  });
  afterEach(() => { vi.restoreAllMocks(); eraseInlineBlock(); });

  it('repaints the whole block once, then only the changed row', () => {
    const first = frame('');
    expect(first).toContain(rule);
    let total = 0;
    for (let n = 1; n <= 20; n += 1) {
      const bytes = frame('a'.repeat(n));
      expect(bytes).not.toContain('─');
      expect(bytes).not.toContain('\u001b[H');
      expect(bytes).not.toMatch(/\u001b\[\d+;\d+H/);
      expect(bytes.startsWith('\u001b[?2026h') && bytes.endsWith('\u001b[?2026l')).toBe(true);
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(100);
      total += Buffer.byteLength(bytes);
    }
    expect(total).toBeLessThanOrEqual(2000);
    expect(writes).toHaveLength(1);
  });

  it('writes nothing for an unchanged frame', () => {
    frame('hi');
    expect(frame('hi')).toBe('');
    expect(writes).toHaveLength(0);
  });

  it('repaints in full when the width changes', () => {
    frame('hi');
    Object.defineProperty(stdout, 'columns', { value: 80, configurable: true });
    const narrow = '─'.repeat(78);
    expect(frame('hi', [], live('hi').map((row) => (row === rule ? narrow : row)))).toContain(narrow);
  });

  it('grows and shrinks the block with relative motion only, repainting nothing unchanged', () => {
    frame('x');
    const grown = frame('x', [], [...live('x'), '  extra']);
    expect(grown).toContain('extra');
    expect(grown).not.toContain('─');
    expect(grown).not.toMatch(/\u001b\[\d+;\d+H/);
    const shrunk = frame('x');
    expect(shrunk).toContain('\u001b[J');
    expect(shrunk).not.toContain('─');
    expect(inlineBlock.rows).toBe(6);
  });

  it('prints finished rows once, above a repainted block', () => {
    frame('x');
    const out = frame('x', ['done line']);
    expect(out.split('done line')).toHaveLength(2);
    expect(out).toContain(rule);
  });

  it('clears screen and scrollback when the conversation is replaced', () => {
    frame('x');
    inlineBlock.clearNext = true;
    expect(frame('x')).toContain('\u001b[2J\u001b[3J');
  });
});

describe('mode selection', () => {
  const cases: Array<[string, NodeJS.ProcessEnv, number, boolean]> = [
    ['plain xterm', { TERM: 'xterm-256color' }, 120, false],
    ['empty env', {}, 120, false],
    ['iTerm', { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }, 120, false],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, 80, false],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, 120, false],
    ['ghostty', { TERM_PROGRAM: 'ghostty' }, 120, false],
    ['kitty', { TERM: 'xterm-kitty' }, 120, false],
    ['vscode', { TERM_PROGRAM: 'vscode' }, 120, false],
    ['alacritty', { TERM: 'alacritty' }, 120, false],
    ['tmux', { TMUX: '/tmp/tmux-1/default,1,0', TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }, 200, true],
    ['screen STY', { STY: '1.pts-0' }, 200, true],
    ['TERM=screen', { TERM: 'screen-256color' }, 200, true],
    ['TERM=tmux', { TERM: 'tmux-256color' }, 200, true],
    ['dumb', { TERM: 'dumb' }, 200, true],
    ['linux console', { TERM: 'linux' }, 200, true],
    ['ssh narrow', { TERM: 'xterm-256color', SSH_CONNECTION: 'a b c d', TERM_PROGRAM: 'Foo' }, 80, true],
    ['ssh wide unknown program', { TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1' }, 200, true],
    ['ssh wide known program', { TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1', TERM_PROGRAM: 'WezTerm' }, 200, false],
    ['ssh wide, unknown width', { SSH_TTY: '/dev/pts/1' }, 0, true],
    ['mobile', { CLIKDEPLOY_CLIENT: 'mobile', TERM_PROGRAM: 'iTerm.app' }, 120, true],
    ['force off beats tmux', { CLIKCODE_INLINE: '0', TMUX: 'x' }, 80, false],
    ['force off beats mobile', { CLIKCODE_INLINE: '0', CLIKDEPLOY_CLIENT: 'mobile' }, 80, false],
    ['force on beats iTerm', { CLIKCODE_INLINE: '1', TERM_PROGRAM: 'iTerm.app' }, 200, true],
  ];
  it.each(cases)('%s', (_name, env, columns, expected) => {
    expect(inlineHistoryMode(env, columns)).toBe(expected);
  });
});

describe('ascii fallback', () => {
  it('is chosen by locale, TERM=linux and the override', () => {
    expect(asciiMode({ LANG: 'en_US.UTF-8' })).toBe(false);
    expect(asciiMode({ LANG: 'C' })).toBe(true);
    expect(asciiMode({ LANG: 'en_US.UTF-8', LC_ALL: 'C' })).toBe(true);
    expect(asciiMode({ LANG: 'C', LC_ALL: 'en_US.utf8' })).toBe(false);
    expect(asciiMode({ LC_CTYPE: 'POSIX' })).toBe(true);
    expect(asciiMode({})).toBe(false);
    expect(asciiMode({ TERM: 'linux', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(asciiMode({ CLIKCODE_ASCII: '1', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(asciiMode({ CLIKCODE_ASCII: '0', LANG: 'C' })).toBe(false);
  });
  it('folds rules, box drawing and the spinner without changing a row\'s width', () => {
    expect(foldAscii('────')).toBe('----');
    expect(foldAscii('│ a ┌─┐')).toBe('| a +-+');
    expect(foldAscii('plain')).toBe('plain');
    expect(foldAscii('⠋  Reading')).toMatch(/^[-\\|/]  Reading$/);
    const row = '── • ✓ … → ⣾';
    expect([...foldAscii(row)]).toHaveLength([...row].length);
    expect(foldAscii(row)).toMatch(/^[\x00-\x7f]*$/);
  });
  it('is applied to the rows the frame writer sends', async () => {
    vi.stubEnv('CLIKCODE_ASCII', '1');
    const { renderFrame } = await import('./prompter/frame-flush.js');
    const sent: string[] = [];
    const self = { safeLiveRows: { limit: 0, rows: new Map() }, pendingFinished: [] as string[], pendingLive: undefined as unknown, frameInFlight: true };
    renderFrame.call(self as never, [], [rule], 0, 1, false);
    sent.push(...(self.pendingLive as { live: string[] }).live);
    expect(sent[0]).toMatch(/^-+$/);
    vi.unstubAllEnvs();
  });
});

describe('inline block stays on the bottom rows', () => {
  const ROWS = 40;
  let term: TestScreen;
  beforeEach(() => {
    writes = [];
    Object.defineProperty(stdout, 'columns', { value: COLS, configurable: true });
    vi.spyOn(stdout, 'write').mockImplementation(((chunk: string, cb?: () => void) => { writes.push(String(chunk)); cb?.(); return true; }) as never);
    eraseInlineBlock();
    inlineBlock.clearNext = true;
    term = new TestScreen(ROWS, COLS);
    host = {
      alternateTranscript: [], alternateTrimmed: 0, viewportRows: () => ROWS, pickerOverlay: [], chromeRows: 0,
      pendingSignals: '', frameInFlight: false, closed: false, suspended: false, flushFrame: () => {},
    };
  });
  afterEach(() => { vi.restoreAllMocks(); eraseInlineBlock(); });
  function paint(text: string, finished: string[] = [], rows = live(text)): void {
    term.write(frame(text, finished, rows));
  }
  const composerRow = (): number => term.screen().findIndex((r) => r.startsWith('>'));
  const message = (n: number): string => `message ${n}`;
  const lastRow = ROWS - 1;

  it('starts with the status rows on the last rows of the screen', () => {
    paint('');
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen()[lastRow]).toContain('claude');
    expect(term.scrollback.filter((r) => r)).toEqual([]);
    expect(term.scrollback.length).toBe(0);
  });

  it('keeps the composer at the bottom as a conversation of 3 then 100 messages grows', () => {
    paint('');
    for (let n = 1; n <= 3; n += 1) paint('', [message(n), '']);
    expect(composerRow()).toBe(lastRow - 2);
    const shown = term.screen().filter((r) => r.startsWith('message'));
    expect(shown).toEqual([message(1), message(2), message(3)]);
    expect(term.scrollback.length).toBe(0);
    for (let n = 4; n <= 100; n += 1) paint('', [message(n), '']);
    expect(composerRow()).toBe(lastRow - 2);
    const all = [...term.scrollback, ...term.screen()].filter((r) => r.startsWith('message'));
    expect(all).toEqual(Array.from({ length: 100 }, (_, i) => message(i + 1)));
    // No blank row was pushed into the saved lines ahead of the first message.
    expect(term.scrollback[0]).toBe(message(1));
  });

  it('keeps it at the bottom when the block grows and shrinks', () => {
    paint('');
    paint('', [message(1), '']);
    paint('hi', [], [...live('hi'), '  extra 1', '  extra 2']);
    expect(term.screen()[lastRow]).toBe('  extra 2');
    expect(term.scrollback.length).toBe(0);
    paint('hi');
    expect(term.screen()[lastRow]).toContain('claude');
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(1)]);
    expect(term.scrollback.length).toBe(0);
  });

  it('reprints a replaced conversation at the bottom, and a long one from the top', () => {
    paint('');
    paint('', [message(1), '']);
    inlineBlock.clearNext = true;
    paint('', [message(7), '']);
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(7)]);
    expect(term.scrollback.length).toBe(0);
    inlineBlock.clearNext = true;
    paint('', Array.from({ length: 60 }, (_, i) => message(i)));
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.scrollback[0]).toBe(message(0));
  });

  it('follows a shorter screen and a taller one', () => {
    paint('');
    paint('', [message(1), '']);
    term.resize(30);
    (host as { viewportRows: () => number }).viewportRows = () => 30;
    paint('x');
    expect(composerRow()).toBe(30 - 3);
    term.resize(40);
    (host as { viewportRows: () => number }).viewportRows = () => 40;
    paint('xy');
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(1)]);
  });

  it('after a width change repaints the block in place at the bottom', () => {
    paint('');
    paint('', [message(1), '']);
    Object.defineProperty(stdout, 'columns', { value: COLS - 10, configurable: true });
    paint('w');
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(1)]);
  });
});

describe('the phone board', () => {
  const ROWS = 40;
  const BUDGET = 22; // the rows the phone reports above its keyboard
  let screen: TestScreen;
  const draw = (surface: string, rows: string[], cursorRow = rows.length - 1): void => {
    writes.length = 0;
    (host as { surface: string }).surface = surface;
    flushInlineFrame.call(host as never, [], { live: rows, cursorRow, cursorColumn: 3, hideCursor: false });
    screen.write(writes.join(''));
  };
  const footer = [rule, '> ', rule, '  claude'];
  /** The open board as the prompter hands it over: the list is the overlay, the composer block the live rows. */
  const board = (n: number): string[] => {
    (host as { pickerOverlay: string[]; chromeRows: number }).pickerOverlay = [rule, ...Array.from({ length: n }, (_, i) => `  convo ${i}`), '  hint'];
    (host as { chromeRows: number }).chromeRows = footer.length;
    return footer;
  };

  beforeEach(() => {
    writes = [];
    vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile');
    Object.defineProperty(stdout, 'columns', { value: COLS, configurable: true });
    vi.spyOn(stdout, 'write').mockImplementation(((chunk: string, cb?: () => void) => { writes.push(String(chunk)); cb?.(); return true; }) as never);
    eraseInlineBlock();
    inlineBlock.clearNext = false;
    setPhoneVisibleRows(BUDGET);
    host = { alternateTranscript: [], alternateTrimmed: 0, viewportRows: () => ROWS, pickerOverlay: [], chromeRows: 0, pendingSignals: '', frameInFlight: false, closed: false, suspended: false, flushFrame: () => {}, surface: 'conversation' };
    screen = new TestScreen(ROWS, COLS);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); eraseInlineBlock(); setPhoneVisibleRows(undefined); });

  it('draws the open board from the top row, and the chat from the bottom row once it closes', () => {
    inlineBlock.clearNext = true;
    draw('conversation', live('hi'));
    expect(screen.screen()[ROWS - 1]).toContain('claude');
    inlineBlock.clearNext = true;
    draw('history', board(10), 1);
    const open = screen.screen();
    expect(open[0]).toBe(rule);
    expect(open[1]).toContain('convo 0');
    // a block of the visible budget: the composer block ends on its last row, whatever the list holds
    expect(open[BUDGET - 1]).toContain('claude');
    expect(open.slice(BUDGET).every((row) => row === '')).toBe(true);
    for (const n of [4, 12, 2, 10]) {
      draw('history', board(n), 1);
      const now = screen.screen();
      expect(now[0]).toBe(rule);
      expect(now[BUDGET - 1]).toContain('claude');
      expect(now[BUDGET - 3]).toBe('>');
      expect(now.slice(BUDGET).every((row) => row === '')).toBe(true);
    }
    inlineBlock.clearNext = true;
    (host as { pickerOverlay: string[]; chromeRows: number }).pickerOverlay = [];
    (host as { chromeRows: number }).chromeRows = 0;
    draw('conversation', live('hi'));
    const closed = screen.screen();
    expect(closed[ROWS - 1]).toContain('claude');
    expect(closed.join('')).not.toContain('convo');
  });

  it('ends the open board on the last row the phone reports, as the keyboard comes and goes', () => {
    inlineBlock.clearNext = true;
    draw('history', board(10), 1);
    for (const visible of [ROWS, 22, 14, ROWS, 30]) {
      setPhoneVisibleRows(visible);
      // the board lists what fits above its composer block (capacity), as the real board does
      draw('history', board(Math.min(10, visible - 6)), 1);
      const now = screen.screen();
      expect(now[visible - 1], `visible ${visible}`).toContain('claude');
      expect(now[visible - 3]).toBe('>');
      expect(now.slice(visible).every((row) => row === '')).toBe(true);
    }
  });
});
