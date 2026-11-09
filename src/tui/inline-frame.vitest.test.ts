import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stdout } from 'node:process';
import { flushInlineFrame } from './prompter/frame-flush.js';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode } from './inline.js';
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
    // A block that shrinks stays where it is and erases the rows it no longer has, below itself. Nothing is inserted above
    // the conversation and no blank row is added to the block.
    const shrunk = frame('x');
    expect(shrunk).not.toMatch(/\u001b\[\d*[LM]/);
    expect(shrunk).not.toContain('─');
    expect(inlineBlock.rows).toBe(6);
    expect(inlineBlock.liveRows[0]).toBe('');
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
  const cases: Array<[string, NodeJS.ProcessEnv, number, boolean, boolean?]> = [
    ['plain xterm', { TERM: 'xterm-256color' }, 120, false],
    ['empty env', {}, 120, false],
    ['iTerm', { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }, 120, false],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, 80, false],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, 120, false],
    ['ghostty', { TERM_PROGRAM: 'ghostty' }, 120, false],
    ['kitty', { TERM: 'xterm-kitty' }, 120, false],
    ['vscode', { TERM_PROGRAM: 'vscode' }, 120, false],
    ['alacritty', { TERM: 'alacritty' }, 120, false],
    ['tmux, mouse off (the default)', { TMUX: '/tmp/tmux-1/default,1,0', TERM: 'screen-256color', TERM_PROGRAM: 'iTerm.app' }, 200, true, false],
    ['tmux, mouse on, a good terminal behind it', { TMUX: '/tmp/tmux-1/default,1,0', TERM: 'tmux-256color', TERM_PROGRAM: 'iTerm.app' }, 200, false, true],
    ['tmux, mouse on, plain local terminal', { TMUX: 'x', TERM: 'tmux-256color' }, 200, false, true],
    ['tmux, mouse on, over ssh', { TMUX: 'x', TERM: 'tmux-256color', SSH_TTY: '/dev/pts/1' }, 200, true, true],
    ['screen STY', { STY: '1.pts-0' }, 200, true],
    ['TERM=screen outside tmux', { TERM: 'screen-256color' }, 200, true],
    ['TERM=tmux outside tmux', { TERM: 'tmux-256color' }, 200, true],
    ['dumb', { TERM: 'dumb' }, 200, true],
    ['linux console', { TERM: 'linux' }, 200, true],
    ['ssh narrow, unknown program', { TERM: 'xterm-256color', SSH_CONNECTION: 'a b c d', TERM_PROGRAM: 'Foo' }, 80, true],
    ['ssh wide, known-unknown program: the width says nothing', { TERM: 'xterm-256color', SSH_CONNECTION: 'a b c d', TERM_PROGRAM: 'Foo' }, 300, true],
    ['ssh wide unknown program', { TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1' }, 200, true],
    ['ssh wide known program', { TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1', TERM_PROGRAM: 'WezTerm' }, 200, false],
    ['the phone terminal is a client like any other: no special case', { CLIKDEPLOY_CLIENT: 'mobile', TERM: 'xterm-256color' }, 120, false],
    ['force off beats tmux', { CLIKCODE_INLINE: '0', TMUX: 'x' }, 80, false],
    ['force on beats iTerm', { CLIKCODE_INLINE: '1', TERM_PROGRAM: 'iTerm.app' }, 200, true],
  ];
  it.each(cases)('%s', (_name, env, _columns, expected, mouse) => {
    expect(inlineHistoryMode(env, () => mouse ?? false)).toBe(expected);
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

  it('keeps its place when the block grows and shrinks', () => {
    paint('');
    paint('', [message(1), '']);
    paint('hi', [], [...live('hi'), '  extra 1', '  extra 2']);
    expect(term.screen()[lastRow]).toBe('  extra 2');
    expect(term.scrollback.length).toBe(0);
    paint('hi');
    // The block gave two rows up: it owns only its own rows, so it stays where it is and the rows below it are blank.
    expect(composerRow()).toBe(lastRow - 4);
    expect(term.screen()[lastRow - 2]).toContain('claude');
    expect(term.screen()[lastRow - 1]).toBe('');
    expect(term.screen()[lastRow]).toBe('');
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(1)]);
    expect(term.scrollback.length).toBe(0);
  });

  it('takes the blank rows above a short conversation back even when the block shrank in between: none reaches the saved lines', () => {
    paint('');
    paint('', [message(1), '']);
    paint('', [], [...live(''), '  esc stop', '  working']);
    paint('');
    for (let n = 2; n <= 90; n += 1) paint('', [message(n)]);
    expect(term.scrollback[0]).toBe(message(1));
    expect([...term.scrollback, ...term.screen()].filter((r) => r.startsWith('message'))).toHaveLength(90);
    // The only blank row in the saved lines is the one the conversation itself retired after message 1.
    expect(term.scrollback.filter((r) => r === '')).toHaveLength(1);
    expect(term.scrollback[1]).toBe('');
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

  it('writes a whole conversation again (clear screen and scrollback, every row, the live block) as ONE write inside ONE synchronized update', () => {
    paint('');
    writes.length = 0;
    inlineBlock.clearNext = true;
    paint('', Array.from({ length: 2000 }, (_, i) => message(i)));
    expect(writes).toHaveLength(1);
    const frameBytes = writes[0]!;
    expect(frameBytes.startsWith('\u001b[?2026h')).toBe(true);
    expect(frameBytes.endsWith('\u001b[?2026l')).toBe(true);
    expect(frameBytes.match(/\u001b\[\?2026[hl]/g)).toHaveLength(2); // none between: a client that holds the picture until the end holds ALL of it
    expect(frameBytes).toContain('\u001b[3J');
    expect(frameBytes).toContain(message(1999));
  });

  it('follows a shorter screen and a taller one: the settled resize writes the conversation again, anchored to the new last row', () => {
    paint('');
    paint('', [message(1), '']);
    term.resize(30);
    (host as { viewportRows: () => number }).viewportRows = () => 30;
    inlineBlock.clearNext = true;
    paint('x', [message(1), '']);
    expect(composerRow()).toBe(30 - 3);
    term.resize(40);
    (host as { viewportRows: () => number }).viewportRows = () => 40;
    inlineBlock.clearNext = true;
    paint('xy', [message(1), '']);
    expect(composerRow()).toBe(lastRow - 2);
    expect(term.screen().filter((r) => r.startsWith('message'))).toEqual([message(1)]);
  });

  // The rows of the conversation in the saved lines and on the screen, in order: every message once, no blank row between them.
  const history = (): string[] => [...term.scrollback, ...term.screen()].filter((row, index, all) => row !== '' || (all.slice(index).some((r) => r !== '') && all.slice(0, index).some((r) => r !== '')));

  it('a block that grows and shrinks under a conversation longer than the screen never puts a blank row into it', () => {
    paint('');
    for (let n = 1; n <= 100; n += 1) paint('', [message(n)]);
    // A turn begins (two rows more) and ends (two fewer), five times over.
    for (let turn = 0; turn < 5; turn += 1) {
      paint('', [], [...live(''), '  esc stop', '  working']);
      paint('');
    }
    // The turn's rows came out of the blank rows the block left below it, so nothing scrolled after the first.
    expect(composerRow()).toBe(lastRow - 4);
    expect(history().filter((row) => row.startsWith('message'))).toEqual(Array.from({ length: 100 }, (_, i) => message(i + 1)));
    // Between the first message and the block there is nothing but messages (the block's own blank rows aside).
    const rows = history();
    const first = rows.indexOf(message(1));
    const last = rows.indexOf(message(100));
    expect(rows.slice(first, last + 1).every((row) => row.startsWith('message'))).toBe(true);
    // The next row retired lands directly above the block, in the rows it left.
    paint('', [message(101)]);
    expect(history().filter((row) => row.startsWith('message')).at(-1)).toBe(message(101));
    expect(term.screen()[composerRow() - 4]).toBe(message(101));
    expect(term.scrollback.filter((row) => row === '')).toEqual([]);
  });

  // The screen changing height under the program, and the program asked where its cursor is (anchorBlock): the block alone is
  // erased from its first row and drawn again there, and nothing else is written. How a terminal grows differs: tmux pulls
  // saved lines back in whatever the cursor does; xterm.js (a phone's web terminal) only with the cursor on the last row, so
  // with the composer's cursor above the footer it adds blank rows at the bottom instead; a client that keeps its content
  // top-aligned never pulls. Whichever it is, ClikCode makes no row of the history: no blank row, none lost, none repeated.
  describe.each([{ terminal: 'xterm.js', pulls: false }, { terminal: 'tmux', pulls: true }, { terminal: 'a client that never pulls saved lines back', pulls: 'never' as const }])('a change of height in $terminal', ({ pulls }) => {
    const heightOf = (height: number): void => { (host as { viewportRows: () => number }).viewportRows = () => height; };
    /** The terminal changes size, the settle asks where its cursor is, and one frame draws the block. */
    const settle = (sizes: number[], finished: string[] = []): string => {
      for (const next of sizes) term.resize(next, pulls);
      heightOf(sizes.at(-1)!);
      inlineBlock.found = term.y - inlineBlock.cursorRow;
      const bytes = frame('', finished, live(''));
      term.write(bytes);
      return bytes;
    };
    const toggle = (height: number): string => settle([height]);
    const shown = (): string[] => [...term.scrollback, ...term.screen()].filter((row) => row.startsWith('message'));
    const blockAt = (): number => term.screen().findLastIndex((row) => row.startsWith('>'));
    const expectedMessages = (count: number): string[] => Array.from({ length: count }, (_, i) => message(i + 1));
    /** The block is whole, directly under the history, the cursor is on its composer, and nothing but blank rows is below it. */
    const blockIntact = (): void => {
      const screen = term.screen();
      const at = blockAt();
      expect(at).toBeGreaterThanOrEqual(4);
      expect(screen.slice(at - 2, at + 3)).toEqual(['  esc stop', rule, '>', rule, '  claude  •  opus  •  ~/projects']);
      expect(screen[at - 3]).toBe('');
      expect(term.y).toBe(at);
      expect(screen.slice(at + 3).every((row) => row === '')).toBe(true);
    };
    /** ClikCode made no blank row: none between the first message and the block's own blank row, none in the saved lines past
     * the start-up ones above a short conversation, every message once and in order. */
    const historyIntact = (count: number, long: boolean): void => {
      const all = [...term.scrollback, ...term.screen()];
      const first = all.findIndex((row) => row.startsWith('message'));
      const last = all.findLastIndex((row) => row.startsWith('message'));
      expect(all.slice(first, last + 1).every((row) => row.startsWith('message'))).toBe(true);
      expect(shown()).toEqual(expectedMessages(count));
      if (long) expect(term.scrollback.filter((row) => row === '')).toEqual([]);
      // Directly under the last message: the block, whose own first row is blank.
      expect(all[last + 1]).toBe('');
      expect(all[last + 2]).toBe('  esc stop');
    };

    it('over 500 messages writes the block only and not one message, and manufactures no row', () => {
      paint('');
      for (let n = 1; n <= 500; n += 1) paint('', [message(n)]);
      for (const next of [67, 40, 67, 40, 25, 67, 40, 30]) {
        const bytes = toggle(next);
        blockIntact();
        historyIntact(500, true);
        expect(bytes).not.toContain('message');
        expect(bytes).not.toMatch(/\u001b\[\d*;\d*H|\u001b\[\d*[LM]|\u001b\[3J|\u001b\[2J/);
        expect(Buffer.byteLength(bytes)).toBeLessThan(1000);
        expect(term.scrollback[0]).toBe(message(1));
      }
    });

    // The keyboard of a phone: 57 rows and 35, again and again, as single sizes and as the burst the client sends while it moves.
    describe.each([{ conversation: 'a long conversation', count: 150, long: true }, { conversation: 'a short conversation', count: 5, long: false }])('over $conversation', ({ count, long }) => {
      const cycles: number[][][] = [
        [[57], [35], [57], [35]],
        [[57, 50, 44, 38, 35], [35, 38, 44, 50, 57], [57, 50, 44, 38, 35], [35, 40, 48, 57]],
        [[57], [35], [57, 50, 44, 38, 35], [57]],
      ];
      it('keeps the history whole, the block intact and no blank row made, through three cycles of keyboard sizes', () => {
        paint('');
        for (let n = 1; n <= count; n += 1) paint('', [message(n)]);
        for (const cycle of cycles) {
          for (const sizes of cycle) {
            const bytes = settle(sizes);
            blockIntact();
            historyIntact(count, long);
            expect(bytes).not.toMatch(/\u001b\[\d*;\d*H|\u001b\[\d*[LM]|\u001b\[3J|\u001b\[2J/);
            expect(Buffer.byteLength(bytes)).toBeLessThan(1000);
          }
        }
      });

      it('puts every row retired during the cycles directly above the block, none lost, no blank row between', () => {
        paint('');
        let total = count;
        for (let n = 1; n <= count; n += 1) paint('', [message(n)]);
        for (const sizes of [[57], [50, 44, 38, 35], [35, 44, 57], [57, 35], [35, 57]]) {
          total += 1;
          settle(sizes, [message(total)]);
          blockIntact();
          historyIntact(total, long);
          expect(term.screen()[blockAt() - 4]).toBe(message(total));
        }
        // And the block grows (a turn begins) and the next row retired still lands above it.
        term.write(frame('', [], [...live(''), '  esc stop', '  working']));
        total += 1;
        term.write(frame('', [message(total)], [...live(''), '  esc stop', '  working']));
        expect(shown()).toEqual(expectedMessages(total));
        expect(term.scrollback.filter((row) => row === '').length).toBeLessThanOrEqual(long ? 0 : ROWS * 2);
      });
    });

    it('a cursor report that never came back repaints the block from the tracked position: no history row, no absolute move, no 3J, no guessed re-anchor', () => {
      paint('');
      for (let n = 1; n <= 5; n += 1) paint('', [message(n)]);
      for (const next of [67, 40, 12]) {
        term.resize(next, pulls);
        heightOf(next);
        inlineBlock.lost = true;
        const bytes = frame('', [], live(''));
        term.write(bytes);
        expect(bytes).not.toContain('message');
        expect(bytes).not.toMatch(/\u001b\[\d*;\d*H|\u001b\[\d*[LM]|\u001b\[3J|\u001b\[2J/);
        expect(term.screen().filter((row) => row.startsWith('>'))).toHaveLength(1);
        expect(term.screen().filter((row) => row.includes('claude'))).toHaveLength(1);
        expect(shown()).toEqual([1, 2, 3, 4, 5].map(message));
        expect(inlineBlock.lost).toBe(false);
      }
    });

    it('a settled resize that leaves the block where it was draws the block again and nothing above it', () => {
      paint('');
      for (let n = 1; n <= 100; n += 1) paint('', [message(n)]);
      term.resize(ROWS, pulls);
      inlineBlock.found = term.y - inlineBlock.cursorRow;
      const bytes = frame('', [], live(''));
      term.write(bytes);
      expect(bytes).not.toContain('message');
      expect(Buffer.byteLength(bytes)).toBeLessThan(1000);
      blockIntact();
      historyIntact(100, true);
    });
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

/** A modal surface (the board, the palette, a picker) is the whole visible screen: opening it clears the screen and not the
 * saved lines, it is drawn from the top row at the screen's height, and closing it writes the conversation's rows again. */
describe('a modal surface is the whole visible screen', () => {
  const ROWS = 30;
  let term: TestScreen;
  let reseeds: number;
  const footer = [rule, '> ', rule, '  claude  •  opus  •  ~/projects'];
  const list = ['Recent', '  first chat', '  second chat'];
  const message = (n: number): string => `message ${n}`;
  const paint = (rows: string[], overlay: string[] = [], finished: string[] = []): void => {
    host.pickerOverlay = overlay;
    host.chromeRows = footer.length;
    host.surface = overlay.length ? 'history' : 'conversation';
    writes.length = 0;
    flushInlineFrame.call(host as never, finished, { live: rows, cursorRow: rows.length - 3, cursorColumn: 3, hideCursor: false });
    term.write(writes.join(''));
  };
  const withChat = (n: number): string[] => [...Array.from({ length: n }, (_, i) => `live ${i}`), ...footer];
  beforeEach(() => {
    writes = []; reseeds = 0;
    Object.defineProperty(stdout, 'columns', { value: COLS, configurable: true });
    vi.spyOn(stdout, 'write').mockImplementation(((chunk: string, cb?: () => void) => { writes.push(String(chunk)); cb?.(); return true; }) as never);
    eraseInlineBlock();
    Object.assign(inlineBlock, { clearNext: true, page: false, tail: [], height: 0 });
    term = new TestScreen(ROWS, COLS);
    host = {
      alternateTranscript: [], alternateTrimmed: 0, viewportRows: () => term.height, pickerOverlay: [], chromeRows: 0, surface: 'conversation',
      emitted: { requestReseed: () => { reseeds += 1; } },
      pendingSignals: '', frameInFlight: false, closed: false, suspended: false, flushFrame: () => {},
    };
    paint(footer, [], []);
    for (let n = 1; n <= 60; n += 1) paint(footer, [], [message(n)]);
  });
  afterEach(() => { vi.restoreAllMocks(); eraseInlineBlock(); Object.assign(inlineBlock, { page: false, tail: [] }); });

  it('opens over the whole screen from the first row, leaving the saved lines alone and no row of the conversation beside it', () => {
    const before = [...term.scrollback];
    paint(withChat(4), list);
    expect(term.screen()[0]).toBe('Recent');
    expect(term.screen()[ROWS - 3]).toBe('>');
    expect(term.screen()[ROWS - 1]).toContain('claude');
    expect(term.screen().some((row) => row.startsWith('message') || row.startsWith('live'))).toBe(false);
    expect(term.scrollback).toEqual(before);
    expect(term.scrollback.length).toBeGreaterThan(20);
  });

  it('closes by writing the conversation again, ending on the last row, with nothing of the surface left', () => {
    const was = [...term.scrollback, ...term.screen()];
    paint(withChat(4), list);
    paint(footer, [], [message(61)]);
    paint(footer);
    const now = [...term.scrollback, ...term.screen()].filter((row) => row.startsWith('message'));
    expect(now).toEqual(Array.from({ length: 61 }, (_, i) => message(i + 1)));
    expect(term.screen().some((row) => row.includes('Recent') || row.includes('first chat'))).toBe(false);
    expect(term.screen()[ROWS - 3]).toBe('>');
    expect(was.filter((row) => row.startsWith('message')).length).toBe(60);
    expect(reseeds).toBe(0);
  });

  it('draws again from the top at a new height, and has the conversation written whole when it closes', () => {
    paint(withChat(4), list);
    term.resize(ROWS + 20);
    paint(withChat(4), list);
    expect(term.screen()[0]).toBe('Recent');
    expect(term.screen()[ROWS + 20 - 1]).toContain('claude');
    expect(term.screen().some((row) => row.startsWith('message'))).toBe(false);
    expect(reseeds).toBe(1);
  });

  it('draws only the rows that changed while it stays open', () => {
    paint(withChat(4), list);
    paint(withChat(4), [...list, '  third chat']);
    expect(writes.join('')).not.toContain('first chat');
    expect(writes.join('')).toContain('third chat');
    expect(writes.join('')).not.toContain('\u001b[2J');
  });
});
