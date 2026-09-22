import { describe, expect, it } from 'vitest';
import { decodeFrames, encodeFrame } from './protocol.js';

describe('encodeFrame/decodeFrames', () => {
  it('round-trips a single message', () => {
    const frame = encodeFrame({ type: 'phase', message: 'thinking' });
    const { messages, rest } = decodeFrames(frame);
    expect(messages).toEqual([{ type: 'phase', message: 'thinking' }]);
    expect(rest).toBe('');
  });

  it('decodes several frames delivered in one chunk', () => {
    const chunk = encodeFrame({ type: 'phase', message: 'one' }) + encodeFrame({ type: 'phase', message: 'two' });
    const { messages, rest } = decodeFrames(chunk);
    expect(messages).toEqual([{ type: 'phase', message: 'one' }, { type: 'phase', message: 'two' }]);
    expect(rest).toBe('');
  });

  it('holds back a trailing partial frame for the next chunk', () => {
    const whole = encodeFrame({ type: 'phase', message: 'complete' });
    const partial = '{"type":"phase","mess';
    const first = decodeFrames(whole + partial);
    expect(first.messages).toEqual([{ type: 'phase', message: 'complete' }]);
    expect(first.rest).toBe(partial);
    // The rest of the split frame arrives in the next chunk, prepended by the caller.
    const second = decodeFrames(`${first.rest}age":"finished"}\n`);
    expect(second.messages).toEqual([{ type: 'phase', message: 'finished' }]);
    expect(second.rest).toBe('');
  });

  it('drops one corrupt frame without losing the frames around it', () => {
    const chunk = `not json at all\n${encodeFrame({ type: 'phase', message: 'still works' })}`;
    const { messages } = decodeFrames(chunk);
    expect(messages).toEqual([{ type: 'phase', message: 'still works' }]);
  });

  it('ignores an empty chunk', () => {
    expect(decodeFrames('')).toEqual({ messages: [], rest: '' });
  });
});
