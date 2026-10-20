/** A frame that changes a row does not blink the caret, and a resize burst blanks the screen once. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

function session(): HarnessSession {
  return {
    id: 's', conversationId: 's', route: 'local', accountId: 'acct', provider: 'Grok Build', model: null,
    name: 'Quiet chat', nameSource: 'user', workspace: '/tmp/quiet', createdAt: '', updatedAt: '', status: 'active',
    messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi back' }],
  } as HarnessSession;
}

describe('frames', () => {
  const written: string[] = [];
  let rl: TerminalHarnessPrompter;
  afterEach(() => {
    vi.useRealTimers();
    rl?.close();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });
  function open(): TerminalHarnessPrompter {
    written.length = 0;
    Object.assign(process.stdout, { isTTY: true, columns: 80, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
      written.push(String(chunk));
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
    rl = new TerminalHarnessPrompter();
    return rl;
  }

  it('leave a visible caret alone while a key changes the composer', () => {
    const prompter = open();
    prompter.render(session());
    expect(written.join('')).toContain('\u001b[?25h');
    for (const text of ['a', 'ab', 'abc']) {
      written.length = 0;
      prompter.paint(text, [], 0, '› ', text.length);
      const frame = written.join('');
      expect(frame).toContain('abc'.slice(0, text.length));
      expect(frame).not.toContain('?25l');
      expect(frame).not.toContain('?25h');
    }
  });

  it('hide the caret once for a list that asks for it and show it once after', () => {
    const prompter = open();
    prompter.render(session());
    written.length = 0;
    prompter.paint('', [{ label: 'Grok', value: 'grok' }], 0, '› ', 0, { capacity: 4, hideCursor: true, title: 'Choose' });
    expect(written.join('').match(/\?25l/g)).toHaveLength(1);
    expect(written.join('').indexOf('?25l')).toBeLessThan(written.join('').indexOf('Choose'));
    written.length = 0;
    prompter.pickerOverlay = [];
    prompter.paint('', [], 0, '› ', 0);
    expect(written.join('').match(/\?25h/g)).toHaveLength(1);
  });

  it('clear and repair draw hide the caret and show it again', () => {
    const prompter = open();
    prompter.render(session());
    written.length = 0;
    prompter.requestRedraw('repair');
    prompter.forgetScreenPosition();
    prompter.paint('', [], 0, '› ', 0);
    const frame = written.join('');
    expect(frame).toContain('\u001b[2J');
    expect(frame.indexOf('?25l')).toBeLessThan(frame.indexOf('[2J'));
    expect(frame.lastIndexOf('?25h')).toBeGreaterThan(frame.indexOf('[2J'));
  });

  it('a resize burst draws one frame, with one clear, and keys echo while it settles', () => {
    vi.useFakeTimers();
    const prompter = open();
    prompter.render(session());
    written.length = 0;
    for (const rows of [30, 24, 20]) {
      Object.assign(process.stdout, { rows });
      prompter.onResize();
    }
    expect(written.join('')).toBe('');
    // A key typed in the middle of the burst is drawn at once and does not clear.
    prompter.paint('typing', [], 0, '› ', 6);
    const echo = written.join('');
    expect(echo).toContain('typing');
    expect(echo).not.toContain('[2J');
    written.length = 0;
    vi.advanceTimersByTime(200);
    const settled = written.join('');
    expect(settled.match(/\u001b\[2J/g)).toHaveLength(1);
    expect(settled.match(/\?1000h/g)).toHaveLength(1);
    expect(settled).toContain('typing');
  });
});
