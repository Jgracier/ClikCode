import { describe, expect, it } from 'vitest';
import type { SignInUi } from '../../../gateway/login/vendor-sign-in.js';
import { accountFirst } from './login.js';

/** A screen whose key field answers `typed` (undefined: never answered). */
function screen(typed?: string) {
  const seen: string[] = [];
  return {
    seen,
    signal: new AbortController().signal, stop: () => undefined,
    show: (link: { url: string }) => { seen.push(`link ${link.url}`); },
    ask: (prompt: string) => { seen.push(`ask ${prompt}`); return typed === undefined ? new Promise<string>(() => undefined) : Promise.resolve(typed); },
    choose: async (title: string) => { seen.push(`choose ${title}`); return 0; },
  };
}
/** A vendor login: its menu, then its link, then waits for the browser
 * (finishes after `ms`, or rejects when stopped). */
function vendor(ms: number) {
  const picked: (number | undefined)[] = [];
  const run = async (ui: SignInUi): Promise<void> => {
    picked.push(await ui.choose('Connect a model provider', ['Sign in with Cline', 'Sign in with ClinePass', 'Bring your own provider']));
    ui.show({ url: 'https://example/device' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ui.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); });
    });
  };
  return { picked, run };
}

describe('accountFirst', () => {
  it('answers the menu itself, shows the link with the key field under it, and is done when the browser sign-in is', async () => {
    const own = screen();
    const { picked, run } = vendor(5);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], own, run)).toBeUndefined();
    expect(picked).toEqual([0]);
    expect(own.seen).toEqual(['link https://example/device', 'ask Or paste a Cline CLI API key · Enter for other sign-ins']);
  });

  it('a pasted key stops the browser sign-in and is returned', async () => {
    const { run } = vendor(60_000);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], screen(' sk-or-v1-x '), run)).toEqual({ key: 'sk-or-v1-x' });
  });

  it('Enter alone stops it for the vendor\'s other sign-ins', async () => {
    const { run } = vendor(60_000);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], screen(''), run)).toEqual({ key: '' });
  });

  it('a question of the vendor\'s own takes over the key field (a pasted code)', async () => {
    const own = screen();
    own.ask = (prompt: string) => { own.seen.push(`ask ${prompt}`); return prompt.startsWith('Or paste') ? new Promise<string>(() => undefined) : Promise.resolve('4/0-code'); };
    let answered = '';
    const done = await accountFirst('Gemini CLI', ['Sign in with Google'], own, async (ui) => {
      ui.show({ url: 'https://example/oauth' });
      answered = await ui.ask('Enter the authorization code', false);
    });
    expect(done).toBeUndefined();
    expect(answered).toBe('4/0-code');
  });
});
