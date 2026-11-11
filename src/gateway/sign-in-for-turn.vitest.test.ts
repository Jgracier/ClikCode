/** A turn refused by the Gateway as signed out signs in where the user is:
 * a worker asks one window showing the conversation, as for a vendor's
 * sign-in -- never a link drawn in every window following the turn. */
import type Conf from 'conf';
import { describe, expect, it, vi } from 'vitest';
import { signInGatewayForTurn } from './sign-in-for-turn.js';
import { SignInEnded, type TurnObserver } from '../turn/observer.js';

describe('the Gateway sign-in a turn needs', () => {
  it('in a worker: asked of the window that runs sign-ins, its link never drawn in every window', async () => {
    const lines: string[] = [];
    const signIn = vi.fn(async () => undefined);
    const login = vi.fn(async (_config: Conf, _options: unknown, deps: { openBrowser?: (url: string) => void }) => { deps.openBrowser?.('https://gateway.example/device'); return {}; });
    const prompter = { activity: (line: string) => { lines.push(line); }, signIn } as unknown as TurnObserver;
    expect(await signInGatewayForTurn({} as Conf, prompter, undefined, login as never)).toBe(true);
    expect(signIn).toHaveBeenCalledWith({ kind: 'gateway', name: expect.any(String) }, undefined);
    expect(login).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('in a worker: a sign-in the window ended says nothing more here', async () => {
    const lines: string[] = [];
    const prompter = { activity: (line: string) => { lines.push(line); }, signIn: async () => { throw new SignInEnded('cancelled', 'cancelled'); } } as unknown as TurnObserver;
    expect(await signInGatewayForTurn({} as Conf, prompter)).toBe(false);
    expect(lines).toEqual([]);
  });
});
