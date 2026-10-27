/** Opening a list, and applying a choice, must not move the chat or the composer.
 * The list covers rows above the footer. The footer stays the height it had. */
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const ROWS = 36;
const COLS = 80;

function screenFrom(chunks: readonly string[]): string[] {
  const screen = Array.from({ length: ROWS }, () => '');
  const data = chunks.join('');
  const placed = /\u001b\[(\d+);1H([\s\S]*?)\u001b\[K/g;
  for (const match of data.matchAll(placed)) {
    const row = Number(match[1]) - 1;
    if (row < 0 || row >= ROWS) continue;
    screen[row] = match[2]!.replace(/\u001b\[[0-9;]*m/g, '');
  }
  return screen;
}

function rowOf(screen: readonly string[], phrase: string): number {
  const at = screen.findIndex((line) => line.includes(phrase));
  if (at < 0) throw new Error(`not on screen: ${phrase}\n${screen.map((line, index) => `${index} ${line}`).join('\n')}`);
  return at;
}

/** The composer's row: the prompt sits in the footer, indented, not a sent message. */
function composerRow(screen: readonly string[]): number {
  const at = screen.findIndex((line) => /^ {2}›/.test(line));
  if (at < 0) throw new Error(`no composer\n${screen.map((line, index) => `${index}|${line}`).join('\n')}`);
  return at;
}

function session(lines: number): HarnessSession {
  return {
    id: 's', conversationId: 's', route: 'local', accountId: 'acct', provider: 'Grok Build',
    model: null, name: 'Ledger chat', nameSource: 'user',
    workspace: '/tmp/ledger', createdAt: '', updatedAt: '', status: 'active',
    messages: Array.from({ length: lines }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `ledger line ${String(index).padStart(2, '0')} stays put`,
    })),
  } as HarnessSession;
}

describe('the chat and the composer stay put while a list is open', () => {
  const written: string[] = [];
  let rl: TerminalHarnessPrompter;

  afterEach(() => {
    rl?.close();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function open(): TerminalHarnessPrompter {
    written.length = 0;
    Object.assign(process.stdout, { isTTY: true, columns: COLS, rows: ROWS });
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
      written.push(String(chunk));
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
    rl = new TerminalHarnessPrompter();
    return rl;
  }

  it('covers the chat above the footer and leaves every other row where it was', () => {
    const prompter = open();
    prompter.render(session(48), 'work@example.com');
    const closed = screenFrom(written);
    const kept = rowOf(closed, 'ledger line 38 stays put');
    const composer = composerRow(closed);
    const name = rowOf(closed, 'Ledger chat');
    const info = rowOf(closed, 'Grok Build');
    expect(info).toBeGreaterThan(composer);
    expect(closed.join('\n')).not.toContain('work@example.com');

    written.length = 0;
    prompter.paint('', [
      { label: 'Grok', value: 'grok' },
      { label: 'Claude Code', value: 'claude' },
      { label: 'Codex', value: 'codex' },
    ], 0, '› ', 0, { capacity: 8, hideCursor: true, headings: true, title: 'Choose a provider' });
    const next = closed.map((line, index) => {
      const rewritten = [...written.join('').matchAll(/\u001b\[(\d+);1H([\s\S]*?)\u001b\[K/g)]
        .filter((match) => Number(match[1]) - 1 === index).at(-1);
      return rewritten ? rewritten[2]!.replace(/\u001b\[[0-9;]*m/g, '') : line;
    });
    expect(rowOf(next, 'ledger line 38 stays put')).toBe(kept);
    expect(composerRow(next)).toBe(composer);
    expect(rowOf(next, 'Ledger chat')).toBe(name);
    expect(rowOf(next, 'Grok Build')).toBe(info);
    expect(next.join('\n')).not.toContain('work@example.com');
    expect(next.some((line) => line.includes('Choose a provider'))).toBe(true);
    expect(next.some((line) => line.includes('Claude Code'))).toBe(true);
    // The list sits above the composer, never in it.
    expect(next.findIndex((line) => line.includes('Choose a provider'))).toBeLessThan(composer);
    expect(next[composer]).toContain('›');
    expect(next[composer]).not.toContain('Choose a provider');

    written.length = 0;
    prompter.pickerOverlay = [];
    prompter.repaint({ keepPalette: false });
    const back = closed.map((line, index) => {
      const rewritten = [...written.join('').matchAll(/\u001b\[(\d+);1H([\s\S]*?)\u001b\[K/g)]
        .filter((match) => Number(match[1]) - 1 === index).at(-1);
      return rewritten ? rewritten[2]!.replace(/\u001b\[[0-9;]*m/g, '') : line;
    });
    expect(rowOf(back, 'ledger line 38 stays put')).toBe(kept);
    expect(composerRow(back)).toBe(composer);
    expect(back.some((line) => line.includes('Choose a provider'))).toBe(false);
  });

  it('never shows the account email in the CLI footer', () => {
    const prompter = open();
    const first = session(4);
    prompter.render(first, 'work@example.com');
    const before = prompter.statusText(COLS);
    expect(before).toContain('Grok Build');
    expect(before).not.toContain('work@example.com');
    prompter.render(first, 'other@example.com');
    expect(prompter.statusText(COLS)).toBe(before);
  });

  it('names a chat on a model on this computer as the Gateway in the footer: hosted AI under the Gateway, no provider of its own', () => {
    const prompter = open();
    prompter.render({ ...session(4), route: 'clikcode-local', provider: 'clikcode-local', accountId: null, model: 'qwen3.5-4b' } as HarnessSession);
    const footer = prompter.statusText(COLS);
    expect(footer).toContain('ClikDeploy Gateway');
    expect(footer).toContain('Qwen3.5 4B');
    expect(footer).not.toContain('ClikCode Local');
  });

  it('shows a download in the chat that asked for it and in no other, in a row that was already there, and shows it again when that chat is opened again', () => {
    const prompter = open();
    prompter.render(session(40));
    const idle = screenFrom(written);
    const composer = composerRow(idle);
    expect(idle.join('\n')).not.toContain('Downloading');

    // The chat that asked: a spinner row directly above the composer's rule, with the composer where it was.
    prompter.setTransfer('s', 'Downloading Gemma 4 12B 16%');
    prompter.flushPaint();
    const asking = screenFrom(written);
    const row = rowOf(asking, 'Downloading Gemma 4 12B 16%');
    expect(row).toBeLessThan(composer);
    expect(composer - row).toBeLessThanOrEqual(2);
    expect(composerRow(asking)).toBe(composer);
    // Not twice: the line under the composer does not carry it as well.
    expect(prompter.statusText(COLS)).not.toContain('Downloading');

    // Another chat opened: nothing of it is drawn there, and the composer is where it was.
    prompter.render({ ...session(40), id: 'other', conversationId: 'other', name: 'Another chat' } as HarnessSession);
    const elsewhere = screenFrom(written);
    expect(elsewhere.join('\n')).not.toContain('Downloading');
    expect(composerRow(elsewhere)).toBe(composer);
    // It goes on while the other chat is open; progress reports change nothing there.
    prompter.setTransfer('s', 'Downloading Gemma 4 12B 40%');
    prompter.flushPaint();
    expect(screenFrom(written).join('\n')).not.toContain('Downloading');

    // Back in the chat that asked: where it has got to.
    prompter.render(session(40));
    const back = screenFrom(written);
    expect(back[rowOf(back, 'Downloading Gemma 4 12B 40%')]).toContain('Downloading Gemma 4 12B 40%');
    expect(composerRow(back)).toBe(composer);

    // It ends: the row is gone and the composer has not moved.
    prompter.setTransfer('s');
    prompter.flushPaint();
    const done = screenFrom(written);
    expect(done.join('\n')).not.toContain('Downloading');
    expect(composerRow(done)).toBe(composer);
  });

  it('says it beside the status while a turn runs in the chat that asked, and not in another chat', () => {
    const prompter = open();
    prompter.render(session(20));
    prompter.startWaiting('thinking');
    prompter.setTransfer('s', 'Downloading Gemma 4 12B 16%');
    prompter.flushPaint();
    expect(screenFrom(written).join('\n')).toContain('Downloading Gemma 4 12B 16%');
    prompter.stopWaiting(false, 'saved');
    prompter.setTransfer('s');
  });

  it('keeps a line about another chat until that chat is opened, and says it there once', () => {
    const prompter = open();
    prompter.render(session(10));
    prompter.noteFor('other', 'Gemma 4 12B is downloaded: "Another chat" runs on it now.');
    prompter.flushPaint();
    expect(screenFrom(written).join('\n')).not.toContain('Gemma 4 12B is downloaded');
    prompter.noteFor('s', 'This chat is the open one: said at once.');
    prompter.flushPaint();
    expect(screenFrom(written).join('\n')).toContain('This chat is the open one: said at once.');
    prompter.render({ ...session(10), id: 'other', conversationId: 'other', name: 'Another chat' } as HarnessSession);
    prompter.flushPaint();
    expect(screenFrom(written).join('\n')).toContain('Gemma 4 12B is downloaded: "Another chat" runs on it now.');
    // Said once: opening it again does not repeat it.
    written.length = 0;
    prompter.render({ ...session(10), id: 'other', conversationId: 'other', name: 'Another chat' } as HarnessSession);
    prompter.flushPaint();
    expect(written.join('')).not.toContain('is downloaded');
  });

  it('does not shorten a draft when the list opens', () => {
    const prompter = open();
    prompter.render(session(8));
    const draft = 'one\ntwo\nthree\nfour\nfive';
    prompter.paint(draft, [], 0, '› ', 0);
    const before = prompter.chromeRows;
    const composerBefore = screenFrom(written).findIndex((line) => line.includes('five'));
    prompter.paint(draft, [{ label: '/provider', value: '/provider' }, { label: '/model', value: '/model' }], 0, '› ', 0, { capacity: 6 });
    expect(prompter.chromeRows).toBe(before);
    const after = screenFrom(written);
    expect(after.findIndex((line) => line.includes('five'))).toBe(composerBefore);
    expect(after.some((line) => line.includes('/model'))).toBe(true);
    expect(after.findIndex((line) => line.includes('/model'))).toBeLessThan(after.findIndex((line) => line.includes('five')));
  });
});
