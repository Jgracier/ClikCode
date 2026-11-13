/** Authenticator codes (RFC 6238) from a seed kept in the vault, so a sign-in that asks for a six-digit code does not need the
 * user's phone. The seed is what a site shows as "secret key" when an authenticator app is set up (base32), or the otpauth://
 * address inside its QR code. The code is typed into the page; neither it nor the seed is ever returned to the agent. */
import { createHmac } from 'node:crypto';

export interface TotpSeed { key: Buffer; digits: number; period: number; algorithm: 'sha1' | 'sha256' | 'sha512' }

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('The saved value is not an authenticator secret key (letters A-Z and digits 2-7).');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  if (out.length < 10) throw new Error('The saved value is too short to be an authenticator secret key.');
  return Buffer.from(out);
}

/** Reads a seed as saved: a bare base32 key, or an otpauth://totp/... address with its own digits, period and algorithm. */
export function parseTotpSeed(saved: string): TotpSeed {
  const text = saved.trim();
  if (/^otpauth:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.host.toLowerCase() !== 'totp') throw new Error('Only time-based codes (otpauth://totp) are supported.');
    const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') throw new Error('Unknown code algorithm in the saved address.');
    const digits = Number(url.searchParams.get('digits') ?? 6), period = Number(url.searchParams.get('period') ?? 30);
    if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 120) throw new Error('Unusual code length or period in the saved address.');
    return { key: base32Decode(url.searchParams.get('secret') ?? ''), digits, period, algorithm };
  }
  return { key: base32Decode(text), digits: 6, period: 30, algorithm: 'sha1' };
}

export const totpCounter = (seed: TotpSeed, nowMs: number): number => Math.floor(nowMs / 1000 / seed.period);

export function totpCode(seed: TotpSeed, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(seed.algorithm, seed.key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const number = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(number % 10 ** seed.digits).padStart(seed.digits, '0');
}

/** The counter each seed last gave a code for, so two calls in a row give two different, consecutive codes (what a site asks
 * for when an authenticator is first registered) and a code is never typed twice. */
const lastUsed = new Map<string, number>();

/** The code to type now. Waits for the next period when this one's code was already used, or when it is about to run out. */
export async function nextTotpCode(name: string, saved: string, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ code: string; waitedMs: number }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const seed = parseTotpSeed(saved);
  const periodMs = seed.period * 1000;
  let waitedMs = 0;
  for (;;) {
    const t = now();
    const counter = totpCounter(seed, t);
    const leftMs = (counter + 1) * periodMs - t;
    if ((lastUsed.get(name) ?? -1) < counter && leftMs >= 4_000) {
      lastUsed.set(name, counter);
      return { code: totpCode(seed, counter), waitedMs };
    }
    await sleep(leftMs + 250);
    waitedMs += leftMs + 250;
  }
}
