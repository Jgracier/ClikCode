import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_PROVIDERS } from '@clikcode/router/ai-local-harness';
import { SEARCH_CHOICE } from '../../../gateway/login/vendor-sign-in.js';
import { keyCandidates, keyRoutedScreen, optionFor } from './login.js';

const routes = [
  { url: 'https://us.example/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'US (Virginia)'] },
  { url: 'https://sg.example/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'Singapore'] },
];
const spec = { command: 'qwen', displayName: 'Qwen Code', binary: 'qwen' } as never;
const multi = { command: 'pi', displayName: 'Pi', binary: 'pi' } as never;
const piRoutes = [
  { provider: 'anthropic', choose: ['Sign in with an API key', 'Anthropic'] },
  { provider: 'openrouter', choose: ['Sign in with an API key', 'OpenRouter'] },
  { provider: 'openai', choose: ['Sign in with an API key', 'OpenAI'] },
  { provider: 'deepseek', choose: ['Sign in with an API key', 'DeepSeek'] },
  { provider: 'minimax', choose: ['Sign in with an API key', 'MiniMax'] },
] as const;

function screen(answers: Record<string, string> = {}, key = 'sk-ws-key') {
  const asked: string[] = [];
  return {
    asked,
    signal: new AbortController().signal, stop: () => undefined, show: () => undefined,
    ask: async (prompt: string) => { asked.push(prompt); return answers[prompt] ?? key; },
    choose: async (title: string) => { asked.push(title); return 0; },
  };
}
/** fetch answering `ok` for the URLs that start with one of `accepts`, 401 otherwise; and the URLs asked. */
function endpoints(...accepts: string[]) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(url); return new Response('{}', { status: accepts.some((start) => url.startsWith(start)) ? 200 : 401 }); }));
  return asked;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('keyRoutedScreen', () => {
  it('asks only for the key, then answers the menus from the first route that accepts it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('{}', { status: url.startsWith('https://us.') ? 401 : 404 })));
    const own = screen();
    const ui = await keyRoutedScreen(spec, routes, own, KEY_PROVIDERS);
    expect(await ui.choose('Connect a Provider', ['Alibaba ModelStudio', 'Third-party Providers'])).toBe(0);
    expect(await ui.choose('Access Method', ['Coding Plan', 'Token Plan', 'Standard API Key'])).toBe(2);
    expect(await ui.choose('Region', ['China (Beijing)', 'Singapore', 'US (Virginia)'])).toBe(1);
    expect(await ui.ask('API Key', true)).toBe('sk-ws-key');
    expect(own.asked).toEqual(['Qwen Code API key, or Enter to choose a provider']);
  });

  it('hands any screen the route does not name to the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    const own = screen({ 'Model IDs': 'qwen3.6-plus' });
    const ui = await keyRoutedScreen(spec, routes, own, KEY_PROVIDERS);
    await ui.choose('Something new', ['A', 'B']);
    await ui.ask('API Key', true);
    expect(await ui.ask('Model IDs', false)).toBe('qwen3.6-plus');
    expect(own.asked).toEqual(['Qwen Code API key, or Enter to choose a provider', 'Something new', 'Model IDs']);
  });

  it('refuses a key no route accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(keyRoutedScreen(spec, routes, screen(), KEY_PROVIDERS)).rejects.toThrow(/no provider Qwen Code signs in to accepts that key/);
  });

  it('with no key, is the vendor\'s own sign-in: every menu goes to the user', async () => {
    const asked = endpoints();
    const own = screen({}, '');
    const ui = await keyRoutedScreen(multi, piRoutes, own, KEY_PROVIDERS);
    expect(ui).toBe(own);
    expect(asked).toEqual([]);
  });

  it('a provider\'s key: probed where it was issued, then its option found through the list\'s search', async () => {
    const asked = endpoints('https://openrouter.ai/');
    const own = screen({}, 'sk-or-v1-abc');
    const ui = await keyRoutedScreen(multi, piRoutes, own, KEY_PROVIDERS);
    // Only OpenRouter could have issued an sk-or- key: nobody else sees it.
    expect(asked).toEqual(['https://openrouter.ai/api/v1/key']);
    expect(await ui.choose('Select authentication method:', ['Sign in with an account', 'Sign in with an API key'])).toBe(1);
    const shown = ['Amazon Bedrock • unconfigured', 'Anthropic • unconfigured', SEARCH_CHOICE];
    expect(await ui.choose('Select provider to configure:', shown)).toBe(2);
    expect(await ui.ask('Search Select provider to configure', false)).toBe('OpenRouter');
    expect(await ui.choose('Select provider to configure:', ['OpenRouter • unconfigured', SEARCH_CHOICE])).toBe(0);
    expect(await ui.ask('Enter OpenRouter API key', true)).toBe('sk-or-v1-abc');
    expect(own.asked).toEqual(['Pi API key, or Enter to choose a provider']);
  });

  it('once the key is in, takes the vendor\'s defaults: its current option, a shown default', async () => {
    endpoints('https://api.deepseek.com/');
    const own = screen({}, 'sk-0123456789abcdef');
    const ui = await keyRoutedScreen(multi, piRoutes, own, KEY_PROVIDERS);
    await ui.choose('Select authentication method:', ['Sign in with an account', 'Sign in with an API key']);
    expect(await ui.choose('Select provider:', ['DeepSeek • unconfigured'])).toBe(0);
    expect(await ui.ask('DEEPSEEK_API_KEY', true)).toBe('sk-0123456789abcdef');
    expect(await ui.ask('Base URL [https://api.deepseek.com/v1]', false, true)).toBe('');
    expect(await ui.choose('Select default model:', ['deepseek-chat', 'deepseek-reasoner'], 1)).toBe(1);
    expect(own.asked).toEqual(['Pi API key, or Enter to choose a provider']);
  });

  it('types into a list\'s own search entry, and passes over a default that is a search (Goose)', async () => {
    endpoints('https://api.anthropic.com/');
    const goose = [{ provider: 'anthropic', choose: ['Manual Configuration', 'Anthropic'] }] as const;
    const ui = await keyRoutedScreen(multi, goose, screen({}, 'sk-ant-api03-x'), KEY_PROVIDERS);
    expect(await ui.choose('How would you like to set up your provider?', ['OpenRouter Login (Recommended)', 'Manual Configuration'])).toBe(1);
    expect(await ui.choose('Which model provider should we use?', ['AI/ML API', 'Amp', 'Search all providers...'])).toBe(2);
    expect(await ui.ask('Search model providers', false)).toBe('Anthropic');
    expect(await ui.choose('Which model provider should we use?', ['Anthropic (Claude and other models from Anthropic)', 'Databricks'])).toBe(0);
    expect(await ui.ask('Provider Anthropic requires ANTHROPIC_API_KEY, please enter a value', true)).toBe('sk-ant-api03-x');
    expect(await ui.choose('Select a model:', ['Search all models...', 'claude-sonnet-4.5'], 0)).toBe(1);
  });

  it('answers a `?label` menu when the vendor shows it, passes over it when not (OpenClaw\'s plugin install)', async () => {
    endpoints('https://api.groq.com/');
    const route = [{ provider: 'groq', choose: ['More…', 'Groq', '?Download from npm', 'Skip for now'] }] as const;
    const providers = ['OpenAI', 'More…', 'Skip for now'];
    const first = await keyRoutedScreen(multi, route, screen({}, 'gsk_x'), KEY_PROVIDERS);
    await first.choose('Model/auth provider', providers);
    await first.choose('Model/auth provider', ['Cerebras', 'Groq']);
    expect(await first.choose('Install Groq plugin?', ['Download from npm (@openclaw/groq-provider)', 'Skip for now'])).toBe(0);
    await first.ask('Enter Groq API key', true);
    expect(await first.choose('Model/auth provider', providers, 0)).toBe(2);
    const again = await keyRoutedScreen(multi, route, screen({}, 'gsk_x'), KEY_PROVIDERS);
    await again.choose('Model/auth provider', providers);
    await again.choose('Model/auth provider', ['Cerebras', 'Groq']);
    await again.ask('Enter Groq API key', true);
    expect(await again.choose('Model/auth provider', providers, 0)).toBe(2);
  });

  it('an option is its label, or the label and then a mark -- never a longer name', () => {
    expect(optionFor(['Azure OpenAI • unconfigured', 'OpenAI • unconfigured'], 'OpenAI')).toBe(1);
    expect(optionFor(['Fireworks AI (OpenAI-compatible)', 'OpenAI ▸ (ChatGPT/Codex subscription)'], 'OpenAI')).toBe(1);
    expect(optionFor(['Moonshot AI', 'Moonshot AI (China)'], 'Moonshot AI (China)')).toBe(1);
    expect(optionFor(['MiniMax CN • unconfigured'], 'MiniMax')).toBe(-1);
  });
});

describe('keyCandidates', () => {
  const providers = (key: string) => keyCandidates(piRoutes, key, KEY_PROVIDERS).map((route) => route.provider);
  it('sends a key with a known prefix only to the provider that issues it', () => {
    expect(providers('sk-ant-api03-x')).toEqual(['anthropic']);
    expect(providers('sk-proj-x')).toEqual(['openai']);
    expect(providers('AIzaSyX')).toEqual([]);
  });
  it('sends a key with none to the providers whose keys carry none', () => {
    expect(providers('sk-0123456789abcdef')).toEqual(['openai', 'deepseek', 'minimax']);
  });
});
