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
