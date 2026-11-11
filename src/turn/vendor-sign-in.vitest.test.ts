/** A turn's sign-in says how it ended once: where it ran, or here, never both. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./vendor-process.js', () => ({ leavePersistentTransport: async () => undefined }));
const login = vi.hoisted(() => ({ run: vi.fn<() => Promise<void>>() }));
vi.mock('../harness/transport/native/login.js', async (original) => ({
  ...(await original<typeof import('../harness/transport/native/login.js')>()),
  loginNativeHarness: login.run,
}));

import { signInForTurn } from './vendor-sign-in.js';
import { SignInEnded, type TurnObserver } from './observer.js';
import type { VendorTurnContext } from './vendor-turn-context.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';

const harness = { command: 'claude', displayName: 'Claude Code', loginArgv: ['auth', 'login'] };

function context(prompter: Partial<TurnObserver> & { signInScreen?: (name: string) => SignInScreen }): VendorTurnContext {
  return { harness, session: { id: 's' }, prompter, state: {}, model: null, attempt: {}, signal: undefined } as unknown as VendorTurnContext;
}

const screen = (): SignInScreen => ({
  signal: new AbortController().signal, show: () => undefined, ask: async () => '', choose: async () => undefined, stop: () => undefined,
});

describe('a turn signing in', () => {
  it('in a worker: the window that ran it said how it ended, and nobody could sign in says nothing', async () => {
    for (const outcome of ['failed', 'cancelled', 'unavailable'] as const) {
      const lines: string[] = [];
      const signIn = async () => { throw new SignInEnded('claude exited with status 1', outcome); };
      expect(await signInForTurn(context({ activity: (line) => { lines.push(line); }, signIn }), {})).toBe(false);
      expect(lines).toEqual([]);
    }
  });

  it('here: withSignIn\'s one line, not a second', async () => {
    const lines: string[] = [];
    login.run.mockRejectedValueOnce(new Error('claude exited with status 1'));
    expect(await signInForTurn(context({ activity: (line) => { lines.push(line); }, signInScreen: screen }), {})).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('did not finish');
  });

  it('a failure nothing said yet is said once', async () => {
    const lines: string[] = [];
    const signIn = async () => { throw new Error('socket closed'); };
    expect(await signInForTurn(context({ activity: (line) => { lines.push(line); }, signIn }), {})).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
