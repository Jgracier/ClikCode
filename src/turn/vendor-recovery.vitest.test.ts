import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VendorTurnContext } from './vendor-turn-context.js';
import type { VendorObserver } from './vendor-observer.js';
import type { AttemptRecord } from './vendor-attempt.js';

const steps = vi.hoisted(() => ({
  signIn: vi.fn(async () => true),
  switched: vi.fn(async () => ({ to: {}, kind: 'other', value: { wrote: false, carriedThread: 'carried' } })),
  retell: vi.fn(async () => 'retold'),
}));
vi.mock('./vendor-sign-in.js', () => ({ signInForTurn: steps.signIn }));
vi.mock('./account-switch.js', () => ({ switchAccountAfterFailure: steps.switched }));
vi.mock('./vendor-process.js', () => ({ leavePersistentTransport: async () => undefined }));
vi.mock('../session/native-thread.js', () => ({ forgetNativeThread: () => undefined }));
vi.mock('./vendor-thread-takeup.js', () => ({ retell: steps.retell, editAnswer: () => undefined, continueAnswer: () => undefined }));

const { recoverFromFailure } = await import('./vendor-recovery.js');

const observer = { recordUnfinishedAttempt: () => undefined } as unknown as VendorObserver;
function ctxWith(attempt: { authRetried: boolean; nativeThreadRetried: boolean }): VendorTurnContext {
  return {
    harness: { command: 'fake', displayName: 'Fake' }, session: { id: 's1' }, account: { id: 'acct-a' },
    attempt, askedText: 'go', turnText: 'go', accounts: {},
  } as unknown as VendorTurnContext;
}
const failedWith = (error: Error): AttemptRecord => ({
  caughtTurnFailure: error, result: { isError: true, text: error.message }, streamError: undefined, cliOutputStarted: false,
  responseBefore: 0, wroteBefore: false, environment: {}, transport: 'acp',
});
const signedOut = () => failedWith(Object.assign(new Error('not logged in'), { errorKind: 'authentication_error' }));
const lostThread = () => failedWith(Object.assign(new Error('thread not found'), { nativeThreadInvalid: true }));

describe('recoverFromFailure', () => {
  beforeEach(() => { steps.signIn.mockClear(); steps.switched.mockClear(); steps.retell.mockClear(); });

  it('moves an ordinary failure to another account', async () => {
    await recoverFromFailure(ctxWith({ authRetried: false, nativeThreadRetried: false }), observer, failedWith(new Error('boom')));
    expect(steps.switched).toHaveBeenCalledTimes(1);
    expect(steps.signIn).not.toHaveBeenCalled();
  });

  it('signs in once and retries in place; a second sign-in failure or a failed sign-in switches', async () => {
    await recoverFromFailure(ctxWith({ authRetried: false, nativeThreadRetried: false }), observer, signedOut());
    expect(steps.signIn).toHaveBeenCalledTimes(1);
    expect(steps.switched).not.toHaveBeenCalled();
    await recoverFromFailure(ctxWith({ authRetried: true, nativeThreadRetried: false }), observer, signedOut());
    expect(steps.signIn).toHaveBeenCalledTimes(1);
    expect(steps.switched).toHaveBeenCalledTimes(1);
    steps.signIn.mockResolvedValueOnce(false);
    await recoverFromFailure(ctxWith({ authRetried: false, nativeThreadRetried: false }), observer, signedOut());
    expect(steps.switched).toHaveBeenCalledTimes(2);
  });

  it('retries once on a fresh thread when the thread to resume is gone, then switches', async () => {
    const ctx = ctxWith({ authRetried: false, nativeThreadRetried: false });
    ctx.turnText = 'A prepared handoff containing the old conversation and go';
    await recoverFromFailure(ctx, observer, lostThread());
    expect(steps.retell).toHaveBeenCalledWith(ctx, 'go', 'clear', false);
    expect(ctx.attempt.nativeThreadRetried).toBe(true);
    expect(ctx.turnText).toBe('retold');
    expect(steps.switched).not.toHaveBeenCalled();
    await recoverFromFailure(ctx, observer, lostThread());
    expect(steps.switched).toHaveBeenCalledTimes(1);
  });
});
