import { describe, expect, it } from 'vitest';
import { isClosedStream } from './program.js';

describe('a closed terminal', () => {
  it('is a hangup, and any other error is a crash', () => {
    expect(isClosedStream(Object.assign(new Error('write'), { code: 'EIO' }))).toBe(true);
    expect(isClosedStream(Object.assign(new Error('write'), { code: 'EPIPE' }))).toBe(true);
    expect(isClosedStream(Object.assign(new Error('lock'), { code: 'ERR_STATE_LOCK' }))).toBe(false);
    expect(isClosedStream(new Error('boom'))).toBe(false);
    expect(isClosedStream('write EPIPE')).toBe(false);
  });
});
