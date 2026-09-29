/** Launches a real VS Code with the extension under development and runs the
 * suite in it. Uses the VS Code on this machine when there is one
 * (CLIKCODE_TEST_VSCODE, else /usr/share/code/code), otherwise downloads one.
 * Run under xvfb-run on a machine without a display.
 *
 * The suite talks to a real ClikCode: the build at ../../dist/index.js (or
 * CLIKCODE_TEST_ENTRY), with CLIKCODE_HOME in a temporary directory so the
 * user's own chats are never touched.
 *
 * CLIKCODE_IT_SUITE=screens runs the screenshot tour instead (README and
 * walkthrough images), in CLIKCODE_IT_THEME (dark|light|hc|hc-light), with demo accounts
 * and conversations seeded into the temporary ClikCode home. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const packageRoot = resolve(__dirname, '../../..');
  // CLIKCODE_IT_EXTENSION_PATH: an unpacked .vsix, to test what is shipped.
  const extensionDevelopmentPath = process.env.CLIKCODE_IT_EXTENSION_PATH ?? packageRoot;
  const extensionTestsPath = resolve(__dirname, 'suite/index.js');
  const entry = process.env.CLIKCODE_TEST_ENTRY ?? resolve(packageRoot, '../../dist/index.js');
  if (!existsSync(entry)) throw new Error(`no ClikCode build at ${entry}: run \`node scripts/build.mjs\` at the repository root first`);
  const root = mkdtempSync(join(tmpdir(), 'clikcode-vscode-it-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(join(workspace, 'hello.ts'), 'export const greeting = "hello";\n');
  writeFileSync(join(workspace, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mean(values: number[]): number {\n  return values.reduce(add, 0) / values.length;\n}\n');
  writeFileSync(join(workspace, 'README.md'), '# Demo\n\nA tiny TypeScript project for trying ClikCode.\n');
  const suite = process.env.CLIKCODE_IT_SUITE ?? 'turn';
  const theme = ({ light: 'Default Light Modern', hc: 'Default High Contrast', 'hc-light': 'Default High Contrast Light' } as Record<string, string>)[process.env.CLIKCODE_IT_THEME ?? ''] ?? 'Default Dark Modern';
  const home = join(root, 'clikcode-home');
  if (suite === 'screens') seedDemoHome(home, workspace);
  writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'clikcode.startWith': 'new' }, null, 2));
  // clikcode.path is machine-scoped: VS Code ignores it in workspace settings, and the
  // test would silently run whatever \`clikcode\` is on PATH. User settings it is.
  mkdirSync(join(root, 'user-data', 'User'), { recursive: true });
  writeFileSync(join(root, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'clikcode.path': entry,
    'workbench.colorTheme': theme,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'window.commandCenter': false,
    'workbench.layoutControl.enabled': false,
  }, null, 2));
  const local = process.env.CLIKCODE_TEST_VSCODE ?? '/usr/share/code/code';
  // On the X display the runner was given (xvfb-run), never a Wayland
  // session the machine happens to have: the window would open on the
  // user's desktop, and the screenshots would capture an empty display.
  delete process.env.WAYLAND_DISPLAY;
  // The environment is this process's; reading a login shell's as well only
  // adds a wait (seconds, on a busy machine minutes) before the extension starts.
  process.env.VSCODE_SKIP_RESOLVING_SHELL_ENV = '1';
  await runTests({
    ...(existsSync(local) ? { vscodeExecutablePath: local } : {}),
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: { CLIKCODE_IT_GREP: process.env.CLIKCODE_IT_GREP ?? '', CLIKCODE_IT_LOG: process.env.CLIKCODE_IT_LOG ?? join(root, 'extension.log'), CLIKCODE_IT_SUITE: suite, CLIKCODE_IT_THEME: process.env.CLIKCODE_IT_THEME ?? 'dark', CLIKCODE_HOME: home, CLIKCODE_IT_WORKSPACE: workspace, CLIKCODE_IT_SCREENSHOT_DIR: process.env.CLIKCODE_IT_SCREENSHOT_DIR ?? '' },
    launchArgs: [
      workspace,
      '--user-data-dir', join(root, 'user-data'),
      '--extensions-dir', join(root, 'extensions'),
      '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', '--ozone-platform=x11',
    ],
  });
}

/** Demo accounts and conversations for the screenshot tour: made up, so no
 * real address or chat ever lands in a README. */
function seedDemoHome(home: string, workspace: string): void {
  mkdirSync(home, { recursive: true });
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  const soon = (ms: number): string => new Date(now + ms).toISOString();
  const account = (id: string, provider: string, label: string, windows: Array<[string, number, number]>, extra: Record<string, unknown> = {}) => ({
    id, provider, label, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `demo:${id}`,
    ...(windows.length ? { usage: { at: iso(60_000), label: windows.map(([name, used]) => `${name} ${100 - used}% left`).join(' · '), windows: windows.map(([name, usedPct, resetMs]) => ({ name, usedPct, resetsAt: soon(resetMs) })) } } : {}),
    ...extra,
  });
  const chat = (id: string, name: string, harness: string, provider: string, model: string, msAgo: number, messages: Array<[string, string]>) => ({
    id, conversationId: id, route: 'local', accountId: null, provider, model, effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted',
    createdAt: iso(msAgo + 600_000), updatedAt: iso(msAgo), status: 'closed', nativeHarness: harness, name, workspace,
    messages: messages.map(([role, content]) => ({ role, content })),
  });
  const state = {
    version: 1, installationId: 'demo', localApiToken: 'demo', devicePrivateKeyPem: 'demo', devicePublicKey: { kty: 'OKP' },
    accounts: [
      account('demo-claude-work', 'anthropic', 'alex@work.dev', [['5h', 38, 2.4 * 3_600_000], ['weekly', 61, 3.2 * 86_400_000]]),
      account('demo-claude-personal', 'anthropic', 'alex@home.dev', [['5h', 92, 1.1 * 3_600_000], ['weekly', 74, 4.5 * 86_400_000]]),
      account('demo-codex', 'openai', 'alex@work.dev', [['5h', 12, 4.2 * 3_600_000], ['weekly', 27, 5.1 * 86_400_000]]),
      account('demo-gemini', 'google', 'alex.dev@gmail.com', [], { status: 'needs_login' }),
    ],
    sessions: [
      chat('demo-1', 'Speed up the CSV importer', 'claude', 'anthropic', 'opus', 40 * 60_000, [['user', 'The CSV importer takes 40s on the sample file. Find out why and make it faster.'], ['assistant', 'Parsing row by row with a regex was the hot spot; it now streams with a single pass. The sample imports in 1.8s.']]),
      chat('demo-2', 'Add retries to the HTTP client', 'codex', 'openai', 'gpt-5.5', 5 * 3_600_000, [['user', 'Add retries with backoff to the HTTP client.'], ['assistant', 'Added exponential backoff with jitter for 429 and 5xx, capped at five attempts, with tests.']]),
      chat('demo-3', 'Why does the build fail on Windows?', 'gemini', 'google', 'gemini-3-pro', 26 * 3_600_000, [['user', 'The build fails on Windows with ENOENT.'], ['assistant', 'The copy step used a POSIX path. It now uses path.join; CI passes on windows-latest.']]),
      chat('demo-4', 'Write tests for the date parser', 'opencode', 'opencode', 'opencode/big-pickle', 3 * 86_400_000, [['user', 'Write tests for parseDate.'], ['assistant', 'Added 14 cases covering time zones, leap years and invalid input.']]),
    ],
    invocations: [],
    globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' }, providerSettings: {},
  };
  writeFileSync(join(home, 'harness-state.json'), `${JSON.stringify(state)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
