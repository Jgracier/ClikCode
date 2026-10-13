import { describe, expect, it } from 'vitest';
import { recoveryCandidates } from './vendor-recovery.js';

const fresh = { effortRetried: false, transientRetried: false, authRetried: false, nativeThreadRetried: false };
const base = {
  failure: new Error('boom'), failureKind: 'other' as const, cliOutputStarted: false,
  effort: undefined, cliTransport: false, hasFallbackTurn: false, attempt: fresh,
};

describe('recoveryCandidates', () => {
  it('offers nothing for an ordinary failure, leaving the account switch', () => {
    expect(recoveryCandidates(base)).toEqual([]);
  });

  it('offers an effort retry once, and only before output', () => {
    const refused = new Error('Unknown effort "medium". Supported: high, max.');
    expect(recoveryCandidates({ ...base, failure: refused, effort: 'medium' })).toEqual(['effort']);
    expect(recoveryCandidates({ ...base, failure: refused, effort: 'medium', cliOutputStarted: true })).toEqual([]);
    expect(recoveryCandidates({ ...base, failure: refused, effort: 'medium', attempt: { ...fresh, effortRetried: true } })).toEqual([]);
  });

  it('offers the compatibility turn only on a CLI transport that declares one', () => {
    expect(recoveryCandidates({ ...base, cliTransport: true, hasFallbackTurn: true })).toEqual(['fallback-turn']);
    expect(recoveryCandidates({ ...base, hasFallbackTurn: true })).toEqual([]);
  });

  it('offers a sign-in or a fresh thread by the failure kind, each once', () => {
    expect(recoveryCandidates({ ...base, failureKind: 'authentication-required' })).toEqual(['sign-in']);
    expect(recoveryCandidates({ ...base, failureKind: 'authentication-required', attempt: { ...fresh, authRetried: true } })).toEqual([]);
    expect(recoveryCandidates({ ...base, failureKind: 'native-thread-invalid' })).toEqual(['native-thread']);
    expect(recoveryCandidates({ ...base, failureKind: 'native-thread-invalid', attempt: { ...fresh, nativeThreadRetried: true } })).toEqual([]);
  });
});
