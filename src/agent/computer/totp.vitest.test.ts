import { expect, it } from 'vitest';
import { nextTotpCode, parseTotpSeed, totpCode, totpCounter } from './totp.js';

// RFC 6238 appendix B: the ASCII key "12345678901234567890", 8 digits, SHA-1.
const RFC = 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8';

it('matches the published test vectors', () => {
  const seed = parseTotpSeed(RFC);
  expect(totpCode(seed, totpCounter(seed, 59_000))).toBe('94287082');
  expect(totpCode(seed, totpCounter(seed, 1111111109_000))).toBe('07081804');
  expect(totpCode(seed, totpCounter(seed, 1234567890_000))).toBe('89005924');
  expect(totpCode(seed, totpCounter(seed, 20000000000_000))).toBe('65353130');
});

it('reads a bare secret key as six digits every thirty seconds, spaces and case aside', () => {
  const seed = parseTotpSeed('gezd gnbv gy3t qojq GEZD GNBV GY3T QOJQ');
  expect(seed).toMatchObject({ digits: 6, period: 30, algorithm: 'sha1' });
  expect(totpCode(seed, totpCounter(seed, 59_000))).toBe('287082');
});

it('refuses what is not a secret key', () => {
  expect(() => parseTotpSeed('not a key!')).toThrow(/not an authenticator secret key/);
  expect(() => parseTotpSeed('ABCD')).toThrow(/too short/);
  expect(() => parseTotpSeed('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toThrow(/time-based/);
});

it('gives two different consecutive codes for two calls, waiting for the next period', async () => {
  let t = 1111111109_000 - 9_000; // start of a period
  const slept: number[] = [];
  const deps = { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } };
  const first = await nextTotpCode('s1', RFC, deps);
  const second = await nextTotpCode('s1', RFC, deps);
  expect(first.waitedMs).toBe(0);
  expect(second.code).not.toBe(first.code);
  expect(second.waitedMs).toBeGreaterThan(0);
  const seed = parseTotpSeed(RFC);
  expect(second.code).toBe(totpCode(seed, totpCounter(seed, t)));
});

it('does not hand out a code with seconds left to live', async () => {
  let t = 60_000 - 2_000; // two seconds before a period ends
  const deps = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  const { code, waitedMs } = await nextTotpCode('s2', RFC, deps);
  expect(waitedMs).toBeGreaterThan(0);
  const seed = parseTotpSeed(RFC);
  expect(code).toBe(totpCode(seed, 2));
});
