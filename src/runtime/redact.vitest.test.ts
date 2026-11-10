import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../search/secrets.js';
import { redactForLog } from './redact.js';

// Built at run time so the source holds no literal key for a scanner to flag.
const KEYS = [
  ['sk', 'live', 'abcdefghijklmnop1234'].join('_'),
  `hf_${'a1B2'.repeat(6)}`,
  `npm_${'x9Y8'.repeat(9)}`,
  `glpat-${'q7W6'.repeat(5)}`,
  `AIza${'Sy0_'.repeat(9)}`,
  `sk-ant-${'r5T4'.repeat(6)}`,
  `ghp_${'m3N2'.repeat(9)}`,
];

describe('secret shapes', () => {
  it('the log and search mask the same vendor keys', () => {
    for (const key of KEYS) {
      expect(redactForLog(`failed with ${key} in the env`)).not.toContain(key);
      expect(maskSecrets(`failed with ${key} in the env`)).not.toContain(key);
    }
  });

  it('keeps the log-only shapes: credentials in a URL and a bearer header', () => {
    expect(redactForLog('GET https://me:hunter2pass@example.com/x')).toBe('GET https://me:[secret hidden]@example.com/x');
    expect(redactForLog('Authorization: Bearer abcdefghijkl12345')).not.toContain('abcdefghijkl12345');
    expect(redactForLog('commit 2c727b912e0c4d9f8a1b3c5d7e9f0a2b4c6d8e0f')).toContain('2c727b912e0c');
  });
});
