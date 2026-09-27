/** A real turn, end to end: VS Code -> extension -> `clikcode ide-bridge` ->
 * session worker -> a vendor harness (OpenCode's free model) and back. */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { ClikCodeApi } from '../../../src/extension';
import type { ChatModel } from '../../../src/model';

function until(api: ClikCodeApi, test: (model: ChatModel) => boolean, what: string, timeoutMs = 60_000): Promise<ChatModel> {
  if (test(api.state)) return Promise.resolve(api.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`timed out waiting for ${what}; state: ${JSON.stringify({ ...api.state, messages: api.state.messages.slice(-3) }).slice(0, 2000)}`)); }, timeoutMs);
    const listener = api.onDidChange((model) => {
      if (!test(model)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(model);
    });
  });
}

/** For the README: the real window, captured when a display is there to
 * capture (xwd under xvfb). */
async function screenshot(name: string): Promise<void> {
  const dir = process.env.CLIKCODE_IT_SCREENSHOT_DIR;
  if (!dir) return;
  // The webview repaints a moment after the model changes.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try { execFileSync('xwd', ['-root', '-silent', '-out', `${dir}/${name}.xwd`]); } catch { /* optional */ }
}

export function turnSuite(): void {
  describe('ClikCode in VS Code', () => {
    let api: ClikCodeApi;

    before(async () => {
      const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode');
      assert.ok(extension, 'the extension is installed in the test instance');
      api = await extension.activate() as ClikCodeApi;
      await vscode.commands.executeCommand('clikcode.focus');
      await api.ready();
    });

    it('opens a chat in the workspace on the installed ClikCode', async () => {
      const model = await until(api, (state) => state.connection === 'ready' && Boolean(state.sessionId), 'a chat to open');
      assert.strictEqual(model.workspace, process.env.CLIKCODE_IT_WORKSPACE);
      assert.ok(model.version, 'the bridge reported its version');
    });

    it('chooses a harness and a model with slash commands', async () => {
      await api.send('/opencode');
      await until(api, (state) => state.harness === 'opencode', 'the OpenCode harness', 120_000);
      await api.send('/model opencode/big-pickle');
      await until(api, (state) => state.model === 'opencode/big-pickle', 'the model', 120_000);
    });

    it('runs a real turn through the session worker and streams the answer', async () => {
      let sawRunning = false;
      const watch = api.onDidChange((state) => { if (state.running) sawRunning = true; });
      await api.send('Reply with exactly the word PONG and nothing else.');
      const done = await until(api, (state) => !state.running && state.messages.some((m) => m.role === 'assistant' && /PONG/.test(m.content)), 'the answer', 200_000);
      watch.dispose();
      assert.ok(sawRunning, 'the chat showed the turn running');
      assert.deepStrictEqual(done.messages.map((m) => m.role), ['user', 'assistant']);
      assert.strictEqual(done.messages[0]!.content, 'Reply with exactly the word PONG and nothing else.');
      await screenshot('turn');
    });

    it('shows a command result as a panel', async () => {
      const before = api.state.notes.length;
      await api.send('/help');
      const model = await until(api, (state) => state.notes.length > before, 'the /help panel');
      assert.strictEqual(model.notes[model.notes.length - 1]!.title, 'Commands');
    });

    it('asks about a selection with the file and lines attached', async () => {
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      assert.ok(folder);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'hello.ts'));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(0, 0, 0, document.lineAt(0).text.length);
      const count = api.state.messages.length;
      await vscode.commands.executeCommand('clikcode.askAboutSelection', 'What is the name of the exported constant? Answer with just the name.');
      const done = await until(api, (state) => !state.running && state.messages.length >= count + 2, 'the answer about the selection', 200_000);
      const [question, answer] = done.messages.slice(-2);
      assert.match(question!.content, /`hello\.ts` line 1:\n```typescript\nexport const greeting/);
      assert.match(answer!.content, /greeting/);
      await vscode.commands.executeCommand('clikcode.focus');
      await screenshot('selection');
    });
  });
}
