import { stdin, stdout } from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING, TerminalInputDecoder, forgetSlowLink, askCursorRow, retakeKeyboard, takeTerminalKeys, waitingEnterAction } from './input-decoder';
import { editWaitingComposer } from './composer-edit';
import { terminalFacts } from './probe';

describe('terminal input decoding', () => {
  it('buffers fragmented Termius escape sequences and UTF-8 characters', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.push(Buffer.from('[D'))).toEqual(['\u001b[D']);
    expect(decoder.push(Buffer.from('\u001bOD\u001b[1;5C'))).toEqual(['\u001b[D', '\u001b[C']);
    const wide = Buffer.from('界');
    expect(decoder.push(wide.subarray(0, 1))).toEqual([]);
    expect(decoder.push(wide.subarray(1))).toEqual(['界']);
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.flush()).toEqual(['\u001b']);
    expect(decoder.push(Buffer.from('x'))).toEqual(['x']);
    expect(decoder.push(Buffer.from('\u001by'))).toEqual(['\u001by']);
  });

  it('holds a slowly arriving bracketed paste open until its end fence', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push('\u001b[200~first line\r')).toEqual([]);
    // The quick escape-sequence flush must not apply while a paste is open:
    // that submitted the first half of a paste as a message.
    expect(decoder.flushDelayMs()).toBeGreaterThanOrEqual(5_000);
    expect(decoder.push('second line')).toEqual([]);
    expect(decoder.push('\u001b[201~x')).toEqual(['\u001b[200~first line\rsecond line\u001b[201~', 'x']);
    expect(decoder.flushDelayMs()).toBeUndefined();
    expect(decoder.push('\u001b')).toEqual([]);
    expect(decoder.flushDelayMs()).toBeLessThan(1_000);
  });

  it('edits a real composer during generation instead of discarding typed keys', () => {
    let draft = { value: '', cursor: 0, changed: false };
    for (const key of ['n', 'e', 'x', 't']) draft = editWaitingComposer(draft.value, draft.cursor, key);
    draft = editWaitingComposer(draft.value, draft.cursor, '\u001b[D');
    draft = editWaitingComposer(draft.value, draft.cursor, '!');
    expect(draft).toEqual({ value: 'nex!t', cursor: 4, changed: true });
    expect(editWaitingComposer(draft.value, draft.cursor, '\u007f')).toEqual({ value: 'next', cursor: 3, changed: true });
  });
});

describe('Enter while a turn runs', () => {
  it('delivers what is typed, whether or not a message is already waiting', () => {
    expect(waitingEnterAction('also do this', false, true)).toBe('deliver');
    expect(waitingEnterAction('  also do this ', true, true)).toBe('deliver');
  });

  it('is "enter again": nothing typed with a message waiting puts it into the chat', () => {
    expect(waitingEnterAction('', true, true)).toBe('send-waiting');
    expect(waitingEnterAction('   ', true, true)).toBe('send-waiting');
  });

  it('does nothing on an empty composer with nothing waiting, or a turn already stopping', () => {
    expect(waitingEnterAction('', false, true)).toBeUndefined();
    expect(waitingEnterAction('', true, false)).toBeUndefined();
  });
});

describe('keys typed between one reader and the next', () => {
  it('go to the next reader, once, in order', async () => {
    const tick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));
    stdin.on('data', KEEP_STDIN_FLOWING);
    try {
      const first: string[] = [];
      const stopFirst = takeTerminalKeys((key) => first.push(key));
      stdin.emit('data', Buffer.from('pl'));
      stopFirst();
      // A sign-in's wait has gone and the prompt has not opened yet.
      stdin.emit('data', Buffer.from('ea'));
      stdin.emit('data', Buffer.from('se'));
      const second: string[] = [];
      const stopSecond = takeTerminalKeys((key) => second.push(key));
      await tick();
      stdin.emit('data', Buffer.from('!'));
      stopSecond();
      expect(first).toEqual(['p', 'l']);
      expect(second).toEqual(['e', 'a', 's', 'e', '!']);
      // A reader that goes before it was handed them leaves them for the next.
      stdin.emit('data', Buffer.from('x'));
      takeTerminalKeys(() => { throw new Error('not this one'); })();
      const third: string[] = [];
      const stopThird = takeTerminalKeys((key) => third.push(key));
      await tick();
      stopThird();
      expect(third).toEqual(['x']);
    } finally {
      stdin.off('data', KEEP_STDIN_FLOWING);
      stdin.pause();
    }
  });
});

describe('the keyboard back after Ctrl+Z', () => {
  it('is re-taken by the reader on top, never by one under it', () => {
    const isTty = stdin.isTTY;
    Object.assign(stdin, { isTTY: false });
    stdin.on('data', KEEP_STDIN_FLOWING);
    try {
      const turnKeys: string[] = [];
      const pickerKeys: string[] = [];
      const turnRetake = vi.fn();
      const stopTurn = takeTerminalKeys((key) => turnKeys.push(key), turnRetake);
      // A picker opened over the turn, with nothing to redo after a suspend.
      const stopPicker = takeTerminalKeys((key) => pickerKeys.push(key));
      retakeKeyboard();
      expect(turnRetake).not.toHaveBeenCalled();
      stdin.emit('data', Buffer.from('j'));
      expect(pickerKeys).toEqual(['j']);
      expect(turnKeys).toEqual([]);
      stopPicker();
      retakeKeyboard();
      expect(turnRetake).toHaveBeenCalledTimes(1);
      stopTurn();
    } finally {
      stdin.off('data', KEEP_STDIN_FLOWING);
      stdin.pause();
      Object.assign(stdin, { isTTY: isTty });
    }
  });
});

describe('private-mode reports are the terminal talking, never typing', () => {
  it('drops a DECRQM answer, however the link chunks them, and records the sync answer', () => {
    stdin.on('data', KEEP_STDIN_FLOWING);
    const keys: string[] = [];
    const stop = takeTerminalKeys((key) => keys.push(key));
    try {
      stdin.emit('data', Buffer.from('a\u001b[?20'));
      stdin.emit('data', Buffer.from('26;2$yb\u001b[?2026;2$yc\u001bP>|xterm.js(5)\u001b\\\u001b[?62;4c'));
      expect(keys).toEqual(['a', 'b', 'c']);
      expect(terminalFacts.syncOutput).toBe(true);
      expect(terminalFacts.name).toBe('xterm.js(5)');
      stdin.emit('data', Buffer.from('\u001b[?2026;0$y'));
      expect(terminalFacts.syncOutput).toBe(false);
    } finally {
      stop();
      terminalFacts.syncOutput = undefined; terminalFacts.name = undefined; terminalFacts.answered = false;
      stdin.off('data', KEEP_STDIN_FLOWING);
      stdin.pause();
    }
  });
});

describe('typed text survives however the link chunks it', () => {
  const typed = (chunks: readonly string[]): string => {
    const decoder = new TerminalInputDecoder();
    let draft = { value: '', cursor: 0 };
    const keys = chunks.flatMap((chunk) => decoder.push(Buffer.from(chunk)));
    for (const key of [...keys, ...decoder.flush()]) draft = editWaitingComposer(draft.value, draft.cursor, key);
    return draft.value;
  };
  const sentence = 'keyboard and the arrows is too sensitive and often twice at the same time';
  const words = sentence.split(' ');

  it('is the same for one byte at a time, word then space, word plus space, and one chunk', () => {
    expect(typed([...sentence])).toBe(sentence);
    expect(typed(words.flatMap((word, index) => (index ? [' ', word] : [word])))).toBe(sentence);
    expect(typed(words.map((word, index) => (index < words.length - 1 ? `${word} ` : word)))).toBe(sentence);
    expect(typed([sentence])).toBe(sentence);
  });

  it('applies a DEL inside a chunk to the character before it, and nothing else', () => {
    // An autocorrect replacement: the word is typed, then deleted and retyped with the space.
    expect(typed(words.flatMap((word, index) => (index < words.length - 1 ? [word, `${'\u007f'.repeat(word.length)}${word} `] : [word])))).toBe(sentence);
    expect(typed(['keyboar', '\u007fd and'])).toBe('keyboad and');
    expect(typed(['ab\u007fc d'])).toBe('ac d');
  });

  it('keeps every character when a terminal report is cut anywhere inside the words', () => {
    const reports = ['\u001b[I', '\u001b[<35;10;20M', '\u001b[?1;2c', '\u001b[12;40R', '\u001b]11;rgb:0000/0000/0000\u0007', '\u001b]11;rgb:0000/0000/0000\u001b\\', '\u001bP>|xterm(1)\u001b\\'];
    for (const report of reports) {
      const whole = `keyboard${report} and the arrows`;
      for (let cut = 0; cut <= whole.length; cut += 1) expect(typed([whole.slice(0, cut), whole.slice(cut)]), `${JSON.stringify(report)} cut at ${cut}`).toBe('keyboard and the arrows');
    }
  });

  it('reads an OSC reply as one key, and `Esc ]` with nothing to end it as typed Alt+] followed by text', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push('\u001b]11;rgb:0/0/0')).toEqual([]);
    expect(decoder.push('\u0007x')).toEqual(['\u001b]11;rgb:0/0/0\u0007', 'x']);
    expect(decoder.push('\u001b]hello')).toEqual([]);
    expect(decoder.flush()).toEqual(['\u001b]', 'h', 'e', 'l', 'l', 'o']);
  });
});

describe('asking the terminal where its cursor is', () => {
  it('writes the query, hands the row to whoever asked and never to a reader as a key; a report nobody asked for is dropped', () => {
    const write = vi.spyOn(stdout, 'write').mockImplementation((() => true) as never);
    stdin.on('data', KEEP_STDIN_FLOWING);
    const keys: string[] = [];
    const stop = takeTerminalKeys((key) => keys.push(key));
    try {
      const rows: Array<number | undefined> = [];
      askCursorRow((row) => rows.push(row));
      expect(write).toHaveBeenCalledWith('\u001b[6n');
      stdin.emit('data', Buffer.from('\u001b[34;5R'));
      stdin.emit('data', Buffer.from('\u001b[3;9R'));
      expect(rows).toEqual([33]);
      expect(keys).toEqual([]);
    } finally {
      stop();
      stdin.off('data', KEEP_STDIN_FLOWING);
      stdin.pause();
      write.mockRestore();
    }
  });

  it('gives up with undefined when nothing answers', async () => {
    const write = vi.spyOn(stdout, 'write').mockImplementation((() => true) as never);
    try {
      const row = await new Promise<number | undefined>((resolve) => askCursorRow(resolve, 10));
      expect(row).toBeUndefined();
    } finally { write.mockRestore(); }
  });
});

describe('a sequence split by a slow link is not an Esc and typed text', () => {
  const at = (ms: number): void => { vi.setSystemTime(ms); };
  const later = (decoder: TerminalInputDecoder): string[] => decoder.flush();
  it.each([150, 400, 900])('ESC, then [A %i ms later: the arrow key, never typed "[A"', (gap) => {
    vi.useFakeTimers(); forgetSlowLink();
    try {
      const decoder = new TerminalInputDecoder();
      at(1_000);
      expect(decoder.push('\u001b')).toEqual([]);
      at(1_000 + 120);
      expect(later(decoder)).toEqual(['\u001b']);
      at(1_000 + gap);
      expect(decoder.push('[A')).toEqual(['\u001b[A']);
      // This link splits sequences: a lone Esc now waits longer before it counts.
      expect(decoder.push('\u001b')).toEqual([]);
      expect(decoder.flushDelayMs()).toBeGreaterThan(120);
    } finally { vi.useRealTimers(); forgetSlowLink(); }
  });

  it('ESC [ then the rest later: one arrow key, no Esc at all', () => {
    vi.useFakeTimers(); forgetSlowLink();
    try {
      const decoder = new TerminalInputDecoder();
      at(1_000);
      expect(decoder.push('\u001b[')).toEqual([]);
      at(1_200);
      expect(later(decoder)).toEqual([]);
      at(1_700);
      expect(decoder.push('B')).toEqual(['\u001b[B']);
    } finally { vi.useRealTimers(); forgetSlowLink(); }
  });

  it('ESC O then the rest later: one arrow key', () => {
    vi.useFakeTimers(); forgetSlowLink();
    try {
      const decoder = new TerminalInputDecoder();
      at(1_000);
      expect(decoder.push('\u001bO')).toEqual([]);
      at(1_300);
      expect(later(decoder)).toEqual([]);
      at(1_500);
      expect(decoder.push('A')).toEqual(['\u001b[A']);
    } finally { vi.useRealTimers(); forgetSlowLink(); }
  });

  it('a genuinely lone Esc is delivered at 120 ms and the text typed after it stays text', () => {
    vi.useFakeTimers(); forgetSlowLink();
    try {
      const decoder = new TerminalInputDecoder();
      at(1_000);
      decoder.push('\u001b');
      expect(decoder.flushDelayMs()).toBe(120);
      at(1_120);
      expect(later(decoder)).toEqual(['\u001b']);
      at(1_400);
      expect(decoder.push('Okay')).toEqual(['O', 'k', 'a', 'y']);
      // Past the window a "[A" is typed.
      decoder.push('\u001b'); at(1_600); later(decoder); at(3_000);
      expect(decoder.push('[A')).toEqual(['[', 'A']);
    } finally { vi.useRealTimers(); forgetSlowLink(); }
  });
});
