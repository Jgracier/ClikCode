/** A window running a sign-in for its worker: once per request, answered
 * with how it ended, and never answered once taken down. */
import { describe, expect, it, vi } from 'vitest';
import { SignInCancelled, type SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { WindowSignIns } from './window-sign-in.js';
import type { ClientCommand, WorkerEvent } from './protocol.js';

const request = (id: string): Extract<WorkerEvent, { type: 'sign-in-request' }> =>
  ({ type: 'sign-in-request', id, command: 'claude', argv: ['auth', 'login'], environment: {}, name: 'Claude Code' });

/** A window's sign-in screen: withdraw aborts it, as the terminal's and the editor's do. */
function window() {
  const lines: string[] = [];
  const screens: SignInScreen[] = [];
  return {
    lines, screens,
    activity: (message: string) => { lines.push(message); },
    signInScreen: (): SignInScreen => {
      const controller = new AbortController();
      const screen: SignInScreen = {
        signal: controller.signal, show: () => undefined, ask: async () => '', choose: async () => undefined,
        stop: () => undefined, withdraw: () => controller.abort(),
      };
      screens.push(screen);
      return screen;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a sign-in a window runs for its worker', () => {
  it('signed in: answered once, and a repeated request is not run again', async () => {
    const answers: ClientCommand[] = [];
    const answer = (response: ClientCommand) => { answers.push(response); };
    let finish!: () => void;
    const login = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const signIns = new WindowSignIns(login);
    const shown = window();
    signIns.run(request('a'), shown, answer);
    signIns.run(request('a'), shown, answer);
    await settle();
    expect(login).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(answers).toEqual([{ type: 'sign-in-response', id: 'a' }]);
  });

  it('taken down: its login is stopped and nothing is answered, even if the login then reports signed in', async () => {
    const answers: ClientCommand[] = [];
    const answer = (response: ClientCommand) => { answers.push(response); };
    let finish!: () => void;
    const signIns = new WindowSignIns(() => new Promise<void>((resolve) => { finish = resolve; }));
    const shown = window();
    signIns.run(request('a'), shown, answer);
    await settle();
    expect(signIns.withdrawAll()).toEqual(['a']);
    expect(shown.screens[0]!.signal.aborted).toBe(true);
    finish();
    await settle();
    expect(answers).toEqual([]);
  });

  it('says whether it was cancelled or failed', async () => {
    const answers: ClientCommand[] = [];
    const answer = (response: ClientCommand) => { answers.push(response); };
    const outcomes = [new SignInCancelled('Claude Code'), new Error('claude exited with status 1')];
    const signIns = new WindowSignIns(async () => { throw outcomes.shift(); });
    signIns.run(request('a'), window(), answer);
    signIns.run(request('b'), window(), answer);
    await settle();
    expect(answers).toEqual([
      { type: 'sign-in-response', id: 'a', error: 'sign-in to Claude Code was cancelled', outcome: 'cancelled' },
      { type: 'sign-in-response', id: 'b', error: 'claude exited with status 1', outcome: 'failed' },
    ]);
  });
});
