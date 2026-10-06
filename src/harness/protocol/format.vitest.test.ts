import { describe, expect, it } from 'vitest';
import { compactCount, dollars, formatDuration, formatElapsed, relativeTime, tildePath } from './format';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('one time format for every surface', () => {
  it('counts up in the two largest units, never padded', () => {
    expect([42_900, 185 * S, H + 15 * M + 3 * S, 2 * D + 3 * H].map(formatElapsed)).toEqual(['42s', '3m 5s', '1h 15m', '2d 3h']);
  });

  it('gives a finished call tenths only under ten seconds', () => {
    expect([3_400, 12_300, 65 * S].map(formatDuration)).toEqual(['3.4s', '12s', '1m 5s']);
  });

  it('says how long ago, then the date', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const ago = (ms: number): string => relativeTime(new Date(now - ms).toISOString(), now);
    expect([10 * S, 5 * M, 5 * H, 3 * D].map(ago)).toEqual(['just now', '5m ago', '5h ago', '3d ago']);
    expect(ago(30 * D)).not.toMatch(/ago/);
    expect(relativeTime(undefined, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('numbers', () => {
  it('compacts counts', () => {
    expect([999, 1_200, 37_010, 7_166_839].map(compactCount)).toEqual(['999', '1.2k', '37k', '7.2M']);
  });

  it('shows a known zero cost as cents, a tiny one to four places', () => {
    expect([0, 0.0042, 1.5].map(dollars)).toEqual(['$0.00', '$0.0042', '$1.50']);
  });
});

describe('paths', () => {
  it('shortens the home directory, given or recognised', () => {
    expect(tildePath('/srv/me/x', '/srv/me')).toBe('~/x');
    expect(tildePath('/srv/me', '/srv/me')).toBe('~');
    expect(tildePath('/srv/meow', '/srv/me')).toBe('/srv/meow');
    expect(tildePath('/home/ann/code')).toBe('~/code');
    expect(tildePath('/Users/ann/code')).toBe('~/code');
  });
});
