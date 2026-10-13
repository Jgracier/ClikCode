import { describe, expect, it } from 'vitest';
import { recoveryCandidates } from './vendor-recovery.js';

const fresh = { authRetried: false, nativeThreadRetried: false };
const base = {
  failureKind: 'other' as const, attempt: fresh,
};

describe('recoveryCandidates', () => {
  it('offers nothing for an ordinary failure, leaving the account switch', () => {
    expect(recoveryCandidates(base)).toEqual([]);
  });

  it('offers a sign-in or a fresh thread by the failure kind, each once', () => {
    expect(recoveryCandidates({ ...base, failureKind: 'authentication-required' })).toEqual(['sign-in']);
    expect(recoveryCandidates({ ...base, failureKind: 'authentication-required', attempt: { ...fresh, authRetried: true } })).toEqual([]);
    expect(recoveryCandidates({ ...base, failureKind: 'native-thread-invalid' })).toEqual(['native-thread']);
    expect(recoveryCandidates({ ...base, failureKind: 'native-thread-invalid', attempt: { ...fresh, nativeThreadRetried: true } })).toEqual([]);
  });
});
