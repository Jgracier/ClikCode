import { describe, expect, it } from 'vitest';
import { decodeWireLine, encodeWireLine } from './wire-gzip.js';

describe('long bridge lines over SSH', () => {
  const long = JSON.stringify({ type: 'chat', chat: 'c', event: { type: 'session', text: 'x'.repeat(200_000) } });

  it('are gzipped for a client that asked, and read back as they were', () => {
    const line = encodeWireLine(long, true);
    expect(line.length).toBeLessThan(long.length / 20);
    expect(line.includes('\n')).toBe(false);
    expect(decodeWireLine(line)).toBe(long);
  });

  it('pass as they were for a client that did not ask, and when short', () => {
    expect(encodeWireLine(long, false)).toBe(long);
    const short = JSON.stringify({ type: 'chat', chat: 'c', event: { type: 'ready' } });
    expect(encodeWireLine(short, true)).toBe(short);
    expect(decodeWireLine(short)).toBe(short);
  });
});
