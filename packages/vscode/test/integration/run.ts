/** Launches a real VS Code with the extension under development and runs the
 * suite in it. Uses the VS Code on this machine when there is one
 * (CLIKCODE_TEST_VSCODE, else /usr/share/code/code), otherwise downloads one.
 * Run under xvfb-run on a machine without a display.
 *
 * The suite talks to a real ClikCode: the build at ../../dist/index.js (or
 * CLIKCODE_TEST_ENTRY), with CLIKCODE_HOME in a temporary directory so the
 * user's own chats are never touched. */
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
  writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'clikcode.startWith': 'new' }, null, 2));
  // clikcode.path is machine-scoped: VS Code ignores it in workspace settings, and the
  // test would silently run whatever \`clikcode\` is on PATH. User settings it is.
  mkdirSync(join(root, 'user-data', 'User'), { recursive: true });
  writeFileSync(join(root, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'clikcode.path': entry }, null, 2));
  const local = process.env.CLIKCODE_TEST_VSCODE ?? '/usr/share/code/code';
  await runTests({
    ...(existsSync(local) ? { vscodeExecutablePath: local } : {}),
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: { CLIKCODE_HOME: join(root, 'clikcode-home'), CLIKCODE_IT_WORKSPACE: workspace, CLIKCODE_IT_SCREENSHOT_DIR: process.env.CLIKCODE_IT_SCREENSHOT_DIR ?? '' },
    launchArgs: [
      workspace,
      '--user-data-dir', join(root, 'user-data'),
      '--extensions-dir', join(root, 'extensions'),
      '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox',
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
