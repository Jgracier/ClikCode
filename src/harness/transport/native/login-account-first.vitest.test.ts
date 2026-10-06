import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_PROVIDERS } from '@clikcode/router/ai-local-harness';
import type { SignInUi } from '../../../gateway/login/vendor-sign-in.js';
import { accountFirst, keyVariableFor, type KeyOffer } from './login.js';

/** A screen answering each ask from `answers` (by prompt start; never
 * answered when none matches). */
function screen(answers: Record<string, string> = {}) {
  const seen: string[] = [];
  return {
    seen,
    signal: new AbortController().signal, stop: () => undefined,
    show: (link: { url: string }) => { seen.push(`link ${link.url}`); },
    ask: (prompt: string) => {
      seen.push(`ask ${prompt}`);
      const match = Object.keys(answers).find((start) => prompt.startsWith(start));
      return match === undefined ? new Promise<string>(() => undefined) : Promise.resolve(answers[match]!);
    },
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
      if (ui.signal?.aborted) { reject(new Error('cancelled')); return; }
      const timer = setTimeout(resolve, ms);
      ui.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); });
    });
  };
  return { picked, run };
}
const offer = (isKey: (text: string) => boolean = (text) => text.startsWith('sk-')): KeyOffer => ({
  prompt: 'Or paste a Cline CLI API key · Enter for other sign-ins', others: true, isKey: async (text) => isKey(text),
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('accountFirst', () => {
  it('opens the key field at once, answers the menu itself, shows the link, and is done on the callback', async () => {
    const own = screen();
    const { picked, run } = vendor(5);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], own, run, offer())).toBeUndefined();
    expect(picked).toEqual([0]);
    expect(own.seen).toEqual(['ask Or paste a Cline CLI API key · Enter for other sign-ins', 'link https://example/device']);
  });

  it('a pasted key stops the browser sign-in and is returned', async () => {
    const { run } = vendor(60_000);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], screen({ 'Or paste': ' sk-or-v1-x ' }), run, offer())).toEqual({ key: 'sk-or-v1-x' });
  });

  it('Enter alone stops it for the vendor\'s other sign-ins', async () => {
    const { run } = vendor(60_000);
    expect(await accountFirst('Cline CLI', ['Sign in with Cline'], screen({ 'Or paste': '' }), run, offer())).toEqual({ key: '' });
  });

  it('a question of the vendor\'s own shares the field: its code goes to the vendor', async () => {
    const own = screen({ 'Paste code here': '4/0-code' });
    let answered = '';
    const done = await accountFirst('Claude Code', [], own, async (ui) => {
      ui.show({ url: 'https://example/oauth' });
      answered = await ui.ask('Paste code here if prompted', false);
    }, offer());
    expect(done).toBeUndefined();
    expect(answered).toBe('4/0-code');
    expect(own.seen).toContain('ask Paste code here if prompted · or paste your Claude Code API key');
  });

  it('the vendor\'s own key question stands alone, and nothing is offered after it (a Base URL)', async () => {
    const own = screen({ 'Paste your API key': 'sk-test-42', 'Base URL': '' });
    const done = await accountFirst('Hermes', [], own, async (ui) => {
      await ui.ask('Paste your API key', true);
      await ui.ask('Base URL [https://api.example/v1]', false, true);
    }, offer());
    expect(done).toBeUndefined();
    expect(own.seen).toEqual(['ask Or paste a Cline CLI API key · Enter for other sign-ins', 'ask Paste your API key', 'ask Base URL [https://api.example/v1]']);
  });

  it('a key pasted into the vendor\'s question is taken as the key', async () => {
    const own = screen({ 'Paste code here': 'sk-ant-api03-x' });
    const done = await accountFirst('Claude Code', [], own, async (ui) => {
      ui.show({ url: 'https://example/oauth' });
      await ui.ask('Paste code here if prompted', false);
      if (ui.signal?.aborted) throw new Error('cancelled');
      await new Promise<void>((_, reject) => ui.signal?.addEventListener('abort', () => reject(new Error('cancelled'))));
    }, offer());
    expect(done).toEqual({ key: 'sk-ant-api03-x' });
  });
});

describe('keyVariableFor', () => {
  const accepts = (...starts: string[]) => vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('{}', { status: starts.some((start) => url.startsWith(start)) ? 200 : 401 })));
  const signal = new AbortController().signal;

  it('the variable whose provider accepts the key (Aider reads several)', async () => {
    accepts('https://openrouter.ai/');
    const aider = { provider: 'aider', authEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VERTEXAI_PROJECT'] };
    expect(await keyVariableFor(aider, 'sk-or-v1-x', signal, KEY_PROVIDERS)).toEqual({ variable: 'OPENROUTER_API_KEY', checked: true });
  });

  it('refuses a key its provider rejects', async () => {
    accepts();
    expect(await keyVariableFor({ provider: 'anthropic', authEnv: ['ANTHROPIC_API_KEY'] }, 'sk-ant-bad', signal, KEY_PROVIDERS)).toBeUndefined();
  });

  it('one variable with no endpoint to ask: that one, unchecked (Cursor)', async () => {
    accepts();
    expect(await keyVariableFor({ provider: 'cursor' }, 'key_x', signal, KEY_PROVIDERS)).toEqual({ variable: 'CURSOR_API_KEY', checked: false });
  });
});
