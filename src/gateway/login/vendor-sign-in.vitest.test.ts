import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminalReplies, chooseLoginLink, choiceKeys, extractLoginCode, readScreenPrompt, runVendorSignIn, type LoginLink, type SignInUi } from './vendor-sign-in.js';
import { extractLoginUrl } from './url.js';

describe('reading a link sign-in', () => {
  it('reads the code each vendor prints, as confirmed from their real logins', () => {
    expect(extractLoginCode('To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG\nConfirm this code in your browser:\n  5FCB-TTXG')).toBe('5FCB-TTXG');
    expect(extractLoginCode('2. Enter this one-time code (expires in 15 minutes)\n   CRLB-RHOR1')).toBe('CRLB-RHOR1');
    expect(extractLoginCode('To authenticate, visit https://github.com/login/device and enter code 3513-924C')).toBe('3513-924C');
    expect(extractLoginCode('', 'https://app.all-hands.dev/oauth/device/verify?user_code=3EQTT6UN')).toBe('3EQTT6UN');
    expect(extractLoginCode('Opening your browser to authenticate...')).toBeUndefined();
    // Cursor: the UUID in its link is not a code.
    expect(extractLoginCode('If your browser didn\'t open, use this link:\nhttps://cursor.com/loginDeepControl?challenge=Yb5&uuid=7002a169-0d5d-4763-9591-2632ba4782e7&mode=login',
      'https://cursor.com/loginDeepControl?challenge=Yb5&uuid=7002a169-0d5d-4763-9591-2632ba4782e7&mode=login')).toBeUndefined();
    expect(extractLoginCode('id 7002A169-0D5D-4763-9591-2632BA4782E7')).toBeUndefined();
  });

  it('finds sign-in links whose path names no auth word on a boundary', () => {
    expect(extractLoginUrl('Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=TUD5-HVED'))
      .toBe('https://www.kimi.ai/code/authorize_device?user_code=TUD5-HVED');
    expect(extractLoginUrl('docs at https://example.com/guide')).toBeUndefined();
    // Drawn inside a box, it ends at the border.
    expect(extractLoginUrl('│ https://authkit.cline.bot/device?user_code=SDRC-GRRT│││╰────')).toBe('https://authkit.cline.bot/device?user_code=SDRC-GRRT');
  });

  it('prefers the link the vendor tried to open where a browser is local, the printed one where none is', () => {
    expect(chooseLoginLink({ printed: 'https://p', opened: 'https://o', local: true })).toBe('https://o');
    expect(chooseLoginLink({ printed: 'https://p', opened: 'https://o', local: false })).toBe('https://p');
    expect(chooseLoginLink({ opened: 'https://o', local: false })).toBe('https://o');
  });
});

describe('reading what a vendor screen waits on, from real screens', () => {
  it('a clack menu: OpenCode\'s login methods', () => {
    const screen = '┌  Add credential\n│\n◆  Login method\n│  ● ChatGPT Pro/Plus (browser)\n│  ○ ChatGPT Pro/Plus (headless)\n│  ○ Manually enter API Key\n└\n';
    const prompt = readScreenPrompt(screen);
    expect(prompt).toEqual({ kind: 'choice', title: 'Login method', choices: ['ChatGPT Pro/Plus (browser)', 'ChatGPT Pro/Plus (headless)', 'Manually enter API Key'], selected: 0, style: 'arrows' });
    expect(choiceKeys(prompt as Extract<typeof prompt, { kind: 'choice' }>, 2)).toBe('\u001b[B\u001b[B\r');
  });

  it('a clack key prompt, and nothing once it is answered', () => {
    expect(readScreenPrompt('┌  Add credential\n│\n◆  Enter your API key\n│  _\n└\n')).toEqual({ kind: 'input', prompt: 'Enter your API key', secret: true });
    expect(readScreenPrompt('◆  Enter your API key\n│  _\n└\n◇  Enter your API key\n│  ▪▪▪▪\n│\n└  Done\n')).toBeUndefined();
  });

  it('an enquirer menu, redrawn on each move: Kiro\'s login methods', () => {
    const screen = '? Select login method ›\n❯ Use with Builder ID\n  Use with Google\n  Use with GitHub\n  Use with Your Organization\n❯ Use with Builder ID\n  Use with Google\n  Use with GitHub\n  Use with Your Organization\n';
    expect(readScreenPrompt(screen)).toMatchObject({ kind: 'choice', title: 'Select login method', choices: ['Use with Builder ID', 'Use with Google', 'Use with GitHub', 'Use with Your Organization'], selected: 0 });
  });

  it('a yes/no question: Aider\'s OpenRouter offer', () => {
    const prompt = readScreenPrompt('No LLM model was specified and no API keys were provided.\nLogin to OpenRouter or create a free account? (Y)es/(N)o [Yes]: ');
    expect(prompt).toEqual({ kind: 'choice', title: 'Login to OpenRouter or create a free account?', choices: ['Yes', 'No'], selected: 0, style: 'yes-no' });
    expect(choiceKeys(prompt as Extract<typeof prompt, { kind: 'choice' }>, 0)).toBe('y\r');
  });

  it('a line waiting for an answer: Hermes, Claude Code', () => {
    expect(readScreenPrompt('Paste your API key: ')).toEqual({ kind: 'input', prompt: 'Paste your API key', secret: true });
    expect(readScreenPrompt('OPENROUTER_API_KEY (or Enter to cancel): ')).toEqual({ kind: 'input', prompt: 'OPENROUTER_API_KEY (or Enter to cancel)', secret: true });
    expect(readScreenPrompt('Paste your API key: *************\nLabel (optional, default: api-key-1):')).toEqual({ kind: 'input', prompt: 'Label (optional, default: api-key-1)', secret: false });
    expect(readScreenPrompt('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > '))
      .toEqual({ kind: 'input', prompt: 'Paste code here if prompted', secret: false });
  });

  it('a numbered menu in a box: Gemini\'s sign-in methods', () => {
    const screen = '╭──────╮\n│ ? Get started │\n│   How would you like to authenticate for this project? │\n│   ● 1. Sign in with Google │\n│     2. Use Gemini API Key │\n│     3. Vertex AI │\n│   No authentication method selected. │\n╰──────╯\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'How would you like to authenticate for this project?', choices: ['Sign in with Google', 'Use Gemini API Key', 'Vertex AI'], selected: 0, style: 'arrows' });
    // Its tips are a numbered list, not a menu: nothing is marked current.
    expect(readScreenPrompt('Tips for getting started:\n1. Create GEMINI.md files to customize your interactions\n2. /help for more information\n3. Ask coding questions\n')).toBeUndefined();
    // Gemini's chat, once signed in, is not a menu.
    expect(readScreenPrompt('? for shortcuts\n>   Type your message or @path/to/file\n/tmp   no sandbox   Auto\n')).toBeUndefined();
  });

  it('a pointer menu with descriptions: Qwen\'s providers', () => {
    const screen = '┌──────┐\n│ Connect a Provider │\n│ │\n│ › Alibaba ModelStudio │\n│   Official recommended setup: Coding Plan, Token Plan, or Standard API Key │\n│ │\n│   Third-party Providers │\n│   Choose a built-in provider and connect with an API key │\n│ │\n│   Custom Provider │\n│   Manually connect a local server, proxy, or unsupported provider │\n│ │\n│ ──────── │\n│ Terms of Services and Privacy Notice: │\n└──────┘\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'Connect a Provider', choices: ['Alibaba ModelStudio', 'Third-party Providers', 'Custom Provider'], selected: 0, style: 'arrows' });
  });

  it('a boxed text field: Qwen\'s and Gemini\'s key boxes', () => {
    expect(readScreenPrompt('┌────┐\n│ │\n│ DeepSeek API Key · Step 1/2 · API Key │\n│ │\n│ Documentation: https://api-docs.deepseek.com/zh-cn/ │\n│ > sk-... │\n│ Enter to submit, Esc to go back │\n└────┘\n'))
      .toEqual({ kind: 'input', prompt: 'DeepSeek API Key: API Key', secret: true });
    expect(readScreenPrompt('┌────┐\n│ DeepSeek API Key · Step 2/2 · Model IDs │\n│ > model-id │\n│ Enter to submit, Esc to go back │\n└────┘\n'))
      .toEqual({ kind: 'input', prompt: 'DeepSeek API Key: Model IDs', secret: false });
    expect(readScreenPrompt('╭────╮\n│ Enter Gemini API Key │\n│ Please enter your Gemini API key. │\n│ ╭──╮ │\n│ │ Paste your API key here │ │\n│ ╰──╯ │\n│ (Press Enter to submit, Esc to cancel, Ctrl+C to clear stored key) │\n╰────╯\n'))
      .toMatchObject({ kind: 'input', secret: true });
    // A one-line box under its label, the hint below it (Cline).
    expect(readScreenPrompt('      Mistral\n\n  API key\n  ╭──────────╮\n  │ Paste your API key here... │\n  ╰──────────╯\n\n     Enter to save, Esc to go back, Ctrl+C to exit\n'))
      .toEqual({ kind: 'input', prompt: 'API key', secret: true });
    // Devin's: a label, a `❭` line holding a placeholder that says more.
    expect(readScreenPrompt('Visit https://app.devin.ai/auth/cli/continue?state=x to sign in, then copy the code and paste it below.\n\nCode:\n❭ Paste the code from the sign-in page\n↵ submit · esc cancel\n'))
      .toEqual({ kind: 'input', prompt: 'Paste the code from the sign-in page', secret: false });
    // Unboxed, as Pi draws it.
    expect(readScreenPrompt(' Enter Anthropic API key\n\n>\n\n (escape/ctrl+c to cancel, enter to submit)\n'))
      .toEqual({ kind: 'input', prompt: 'Enter Anthropic API key', secret: true });
  });

  it('Devin\'s numbered menu, a description under each option', () => {
    const screen = 'Devin CLI\nHow would you like to log in?\n❭ 1 Log in with browser\nRecommended for most users\n2 Paste a token manually\nFor SSH or remote sessions without browser access\n3 Log in with Windsurf for Enterprise\nFor enterprise customers only\n↑↓ select · ↵ confirm · esc cancel\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'How would you like to log in?', choices: ['Log in with browser', 'Paste a token manually', 'Log in with Windsurf for Enterprise'], selected: 0, style: 'arrows' });
  });

  it('Hermes\'s numbered list, answered by typing a number', () => {
    const screen = '  Select provider:\n(●) 1. Nous Portal (Everything your agent needs)\n(○) 2. Fireworks AI\n(○) 3. OpenRouter (Pay-per-use API aggregator)\nChoice [default 1]: ';
    const prompt = readScreenPrompt(screen);
    expect(prompt).toEqual({ kind: 'choice', title: 'Select provider:', choices: ['Nous Portal (Everything your agent needs)', 'Fireworks AI', 'OpenRouter (Pay-per-use API aggregator)'], selected: 0, style: 'number' });
    expect(choiceKeys(prompt as Extract<typeof prompt, { kind: 'choice' }>, 2)).toBe('3\r');
  });

  it('Hermes\'s full-screen radio list, its title scrolled away', () => {
    expect(readScreenPrompt('  ↑↓ navigate  ENTER/SPACE select  ESC cancel\n\n → (●) Nous Portal (Everything your agent needs)\n   (○) Fireworks AI (OpenAI-compatible direct model API)\n   (○) OpenRouter (Pay-per-use API aggregator)\n'))
      .toEqual({ kind: 'choice', title: 'Choose one', choices: ['Nous Portal (Everything your agent needs)', 'Fireworks AI (OpenAI-compatible direct model API)', 'OpenRouter (Pay-per-use API aggregator)'], selected: 0, style: 'arrows' });
  });

  it('Cline\'s cards, the current one marked at its edge', () => {
    const screen = '      Welcome to Cline\n  Connect a model provider to get started.\n\n  ╭──────────────╮\n  │ ☺ Sign in with Cline        → │\n  │   Latest models with regular free promos │\n  ╰──────────────╯\n  ╭──────────────╮\n  │ ✦ Sign in with ChatGPT        │\n  │   Use your ChatGPT Plus subscription │\n  ╰──────────────╯\n  ╭──────────────╮\n  │ ⚷ Bring your own provider     │\n  │   API key or local server (e.g. Ollama) │\n  ╰──────────────╯\n     ↑/↓ navigate, Enter to select, Ctrl+C to exit\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'Connect a model provider to get started.', choices: ['Sign in with Cline', 'Sign in with ChatGPT', 'Bring your own provider'], selected: 0, style: 'arrows' });
  });

  it('Cline\'s long provider list, searchable', () => {
    const screen = '  Choose a provider\n  ╭──────╮\n  │ Search providers... │\n  ╰──────╯\n   Popular\n   ❯ Cline Usage-Billing (OAuth)\n     DeepSeek\n     Anthropic\n   ▼ 220 more\n  Type to search, ↑/↓ navigate, Enter to select, Esc to go back,\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'Popular', choices: ['Cline Usage-Billing (OAuth)', 'DeepSeek', 'Anthropic'], selected: 0, style: 'arrows', searchable: true });
  });

  it('Vibe\'s cards, the current one marked left of its box', () => {
    const screen = '   Welcome to Mistral Vibe\n   Choose your sign in method\n\n   ┌──────────┐\n > │ Launch browser │\n   │ Sign in to Mistral AI Studio and finish setup automatically. │\n   └──────────┘\n\n   or\n\n   ┌──────────┐\n   │ Use an API key │\n   │ Already have a key? Paste it manually instead. │\n   └──────────┘\n   Use ↑↓ to navigate - Enter Select - Esc Cancel\n';
    expect(readScreenPrompt(screen)).toEqual({ kind: 'choice', title: 'Choose your sign in method', choices: ['Launch browser', 'Use an API key'], selected: 0, style: 'arrows' });
  });

  it('the same cards as a progress view are not a menu (Vibe, waiting on the browser)', () => {
    const screen = '   Launch browser\n   Your browser should open automatically\n   ┌──────┐\n > │   Open browser │\n   │   Failed to open browser for sign-in. │\n   └──────┘\n   ┌──────┐\n   │   Complete sign-in │\n   │   Waiting for authentication... │\n   └──────┘\n   If your browser did not open, copy this URL (press c).\n   Press r to retry - Press m to enter API key manually - Esc to cancel\n';
    expect(readScreenPrompt(screen)).toBeUndefined();
  });

  it('Droid\'s one-line pointer list', () => {
    expect(readScreenPrompt('│ Welcome to Factory CLI │\n╰──────╯\nPlease login with your Factory account to continue.\n> Login\n  Exit\n'))
      .toEqual({ kind: 'choice', title: 'Please login with your Factory account to continue.', choices: ['Login', 'Exit'], selected: 0, style: 'arrows' });
  });

  it('a clack confirm on one line: Goose', () => {
    const prompt = readScreenPrompt('┌   goose-configure\n│\n◆  Share anonymous usage data to help improve goose?\n│  ● Yes / ○ No\n└\n');
    expect(prompt).toEqual({ kind: 'choice', title: 'Share anonymous usage data to help improve goose?', choices: ['Yes', 'No'], selected: 0, style: 'sideways' });
    expect(choiceKeys(prompt as Extract<typeof prompt, { kind: 'choice' }>, 1)).toBe('\u001b[C\r');
  });

  it('nothing while a vendor only waits on the browser', () => {
    expect(readScreenPrompt('To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG\nWaiting for authorization...')).toBeUndefined();
    expect(readScreenPrompt('If your browser didn\'t open, use this link:\nhttps://cursor.com/loginDeepControl?x=1')).toBeUndefined();
    expect(readScreenPrompt('Starting login process...\n')).toBeUndefined();
  });
});

describe('answering a TUI\'s questions to its terminal', () => {
  it('answers what Vibe, Gemini and Cline ask on start', () => {
    expect(terminalReplies('\u001b[c\u001b[6n\u001b[?2026$p\u001b]11;?\u0007\u001b[>0q', { row: 4, column: 9 }))
      .toBe('\u001b[?62;22c\u001b[5;10R\u001b[?2026;2$y\u001b]11;rgb:0000/0000/0000\u001b\\\u001bP>|xterm(388)\u001b\\');
    expect(terminalReplies('plain text', { row: 0, column: 0 })).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('running a sign-in', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-sign-in-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const script = async (body: string): Promise<string> => {
    const path = join(dir, 'vendor');
    await writeFile(path, `#!/bin/sh\n[ -t 0 ] && [ -t 1 ] || { echo "not a tty"; exit 9; }\n${body}`);
    await chmod(path, 0o755);
    return path;
  };
  /** A screen that records what it was asked and answers from `answers`. */
  const ui = (answers: { ask?: string[]; choose?: number[] } = {}, signal?: AbortSignal) => {
    const seen: string[] = [];
    const links: LoginLink[] = [];
    const value: SignInUi = {
      show: (link) => { links.push(link); },
      ask: async (prompt, secret) => { seen.push(`ask ${prompt}${secret ? ' (secret)' : ''}`); return answers.ask?.shift() ?? ''; },
      choose: async (title, choices) => { seen.push(`choose ${title}: ${choices.join(' | ')}`); return answers.choose?.shift(); },
      ...(signal ? { signal } : {}),
    };
    return { value, seen, links };
  };

  it('a link: shown once with its code, no browser opened by the vendor, done when it exits', async () => {
    const vendor = await script('echo "To sign in, open this URL in your browser:"\necho "  https://accounts.example/oauth2/device?user_code=AB12-CD34"\nxdg-open "https://accounts.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455"\nsleep 0.6\necho done\n');
    const screen = ui();
    await runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: screen.value });
    expect(screen.links).toEqual([{ url: 'https://accounts.example/oauth2/device?user_code=AB12-CD34', code: 'AB12-CD34' }]);
  });

  it('where a browser is local, the link the vendor tried to open', async () => {
    const vendor = await script('echo "  https://accounts.example/oauth2/device?user_code=AB12-CD34"\nxdg-open "https://accounts.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455"\nsleep 1\n');
    const screen = ui();
    await runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Example', local: true, ui: screen.value });
    expect(screen.links.at(-1)?.url).toBe('https://accounts.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455');
  });

  it('a pasted key, as Hermes asks for one, then its label', async () => {
    const vendor = await script('printf "Paste your API key: "\nread key\nprintf "Label (optional, default: api-key-1): "\nread label\n[ "$key" = "sk-123" ] && [ -z "$label" ] || exit 4\necho saved\n');
    const screen = ui({ ask: ['sk-123', ''] });
    await runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Hermes', local: false, ui: screen.value });
    expect(screen.seen).toEqual(['ask Paste your API key (secret)', 'ask Label (optional, default: api-key-1)']);
  });

  it('a yes/no question answered in ClikCode', async () => {
    const vendor = await script('printf "Login to OpenRouter or create a free account? (Y)es/(N)o [Yes]: "\nread answer\n[ "$answer" = "y" ] || exit 5\necho ok\n');
    const screen = ui({ choose: [0] });
    await runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Aider', local: false, ui: screen.value });
    expect(screen.seen).toEqual(['choose Login to OpenRouter or create a free account?: Yes | No']);
  });

  it('a screen no reader knows, answered by the catalog\'s steps', async () => {
    const vendor = await script('echo "Welcome. How do you want to authenticate"\nread choice\n[ "$choice" = "2" ] || exit 6\necho "Enter key"\nread key\n[ "$key" = "k-1" ] || exit 7\n');
    const screen = ui({ ask: ['k-1'] });
    await runVendorSignIn({
      binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: screen.value,
      steps: [{ when: 'How do you want to authenticate', send: '2{enter}' }, { when: 'Enter key', ask: { prompt: 'API key', secret: true } }],
    });
    expect(screen.seen).toEqual(['ask API key (secret)']);
  });

  it('a cancelled choice ends the vendor', async () => {
    const vendor = await script('printf "Continue? [Y/n] "\nread answer\nsleep 30\n');
    await expect(runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: ui({ choose: [] }).value }))
      .rejects.toThrow(/cancelled/);
  });

  it('is done once the vendor writes its credential, though it goes on into its app', async () => {
    const credential = join(dir, 'auth.json');
    const vendor = await script(`echo '{"token":"t"}' > '${credential}'\necho "Welcome to the app"\nsleep 30\n`);
    const { access } = await import('node:fs/promises');
    const started = Date.now();
    await runVendorSignIn({
      binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: ui().value,
      signedIn: () => access(credential).then(() => true, () => false),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('says what the vendor said when its sign-in fails', async () => {
    const vendor = await script('echo "token rejected"\nexit 3\n');
    await expect(runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: ui().value }))
      .rejects.toThrow(/Example sign-in exited with status 3: token rejected/);
  });

  it('stops the vendor when cancelled', async () => {
    const controller = new AbortController();
    const vendor = await script('echo "  https://accounts.example/oauth2/device?user_code=AB12-CD34"\nsleep 30\n');
    const screen = ui({}, controller.signal);
    screen.value.show = () => controller.abort();
    const started = Date.now();
    await expect(runVendorSignIn({ binary: vendor, args: [], env: {}, displayName: 'Example', local: false, ui: screen.value })).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
