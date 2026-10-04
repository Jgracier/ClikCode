import { stdin } from 'node:process';
import { describe, expect, it } from 'vitest';
import { KEEP_STDIN_FLOWING, TerminalInputDecoder, takeTerminalKeys, waitingEnterAction } from './input-decoder';
import { editWaitingComposer } from './composer-edit';

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

  it('is "enter again": nothing typed with a message waiting stops the turn and sends it', () => {
    expect(waitingEnterAction('', true, true)).toBe('stop-and-send');
    expect(waitingEnterAction('   ', true, true)).toBe('stop-and-send');
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
