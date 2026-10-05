import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyRoutedScreen } from './login.js';

const routes = [
  { url: 'https://us.example/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'US (Virginia)'] },
  { url: 'https://sg.example/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'Singapore'] },
];
const spec = { command: 'qwen', displayName: 'Qwen Code', binary: 'qwen' } as never;

function screen(answers: Record<string, string> = {}) {
  const asked: string[] = [];
  return {
    asked,
    signal: new AbortController().signal, stop: () => undefined, show: () => undefined,
    ask: async (prompt: string) => { asked.push(prompt); return answers[prompt] ?? 'sk-ws-key'; },
    choose: async (title: string) => { asked.push(title); return 0; },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('keyRoutedScreen', () => {
  it('asks only for the key, then answers the menus from the first route that accepts it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('{}', { status: url.startsWith('https://us.') ? 401 : 404 })));
    const own = screen();
    const ui = await keyRoutedScreen(spec, routes, own);
    expect(await ui.choose('Connect a Provider', ['Alibaba ModelStudio', 'Third-party Providers'])).toBe(0);
    expect(await ui.choose('Access Method', ['Coding Plan', 'Token Plan', 'Standard API Key'])).toBe(2);
    expect(await ui.choose('Region', ['China (Beijing)', 'Singapore', 'US (Virginia)'])).toBe(1);
    expect(await ui.ask('API Key', true)).toBe('sk-ws-key');
    expect(own.asked).toEqual(['Qwen Code API key']);
  });

  it('hands any screen the route does not name to the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    const own = screen({ 'Model IDs': 'qwen3.6-plus' });
    const ui = await keyRoutedScreen(spec, routes, own);
    await ui.choose('Something new', ['A', 'B']);
    await ui.ask('API Key', true);
    expect(await ui.ask('Model IDs', false)).toBe('qwen3.6-plus');
    expect(own.asked).toEqual(['Qwen Code API key', 'Something new', 'Model IDs']);
  });

  it('refuses a key no route accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(keyRoutedScreen(spec, routes, screen())).rejects.toThrow(/no Qwen Code endpoint accepts that key/);
  });
});
