import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder } from './protocol.js';

describe('encodeFrame/FrameDecoder', () => {
  it('round-trips a single message', () => {
    const frame = encodeFrame({ type: 'phase', message: 'thinking' });
    expect(new FrameDecoder().push(frame)).toEqual([{ type: 'phase', message: 'thinking' }]);
  });

  it('decodes several frames delivered in one chunk', () => {
    const chunk = encodeFrame({ type: 'phase', message: 'one' }) + encodeFrame({ type: 'phase', message: 'two' });
    expect(new FrameDecoder().push(chunk)).toEqual([{ type: 'phase', message: 'one' }, { type: 'phase', message: 'two' }]);
  });

  it('holds back a trailing partial frame for the next chunk', () => {
    const frames = new FrameDecoder();
    const whole = encodeFrame({ type: 'phase', message: 'complete' });
    expect(frames.push(`${whole}{"type":"phase","mess`)).toEqual([{ type: 'phase', message: 'complete' }]);
    expect(frames.push('age":"finished"}\n')).toEqual([{ type: 'phase', message: 'finished' }]);
  });

  it('drops one corrupt frame without losing the frames around it', () => {
    const chunk = `not json at all\n${encodeFrame({ type: 'phase', message: 'still works' })}`;
    expect(new FrameDecoder().push(chunk)).toEqual([{ type: 'phase', message: 'still works' }]);
  });

  it('ignores an empty chunk', () => {
    expect(new FrameDecoder().push('')).toEqual([]);
  });

  it('keeps a character split across two chunks whole', () => {
    const bytes = Buffer.from(encodeFrame({ type: 'phase', message: 'naïve — ok' }));
    const cut = bytes.indexOf(Buffer.from('ï')) + 1;
    const frames = new FrameDecoder();
    expect(frames.push(bytes.subarray(0, cut))).toEqual([]);
    expect(frames.push(bytes.subarray(cut))).toEqual([{ type: 'phase', message: 'naïve — ok' }]);
  });

  it('assembles a large frame from many small chunks in time linear in its size', () => {
    // A snapshot of a long conversation: 4 MB in 4 KB chunks. Re-splitting
    // everything pending on each chunk took the square of this.
    const text = 'x'.repeat(4 * 1024 * 1024);
    const frame = encodeFrame({ type: 'notice', message: text });
    const frames = new FrameDecoder();
    const started = performance.now();
    let decoded: unknown[] = [];
    for (let offset = 0; offset < frame.length; offset += 4096) decoded = decoded.concat(frames.push(frame.slice(offset, offset + 4096)));
    expect(decoded).toEqual([{ type: 'notice', message: text }]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
