/** ClikCode in VS Code, end to end: VS Code -> the extension's page ->
 * `clikcode ide-bridge` -> session worker -> a vendor harness (OpenCode's
 * free model) and back, driven through the page the way a user drives it. */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ClikCodeApi } from '../../../src/extension';
import { activate, click, key, openProviderList, pickProviderModel, query, screenshot, sleep, type, until, waitFor } from './helpers';

export function chatSuite(): void {
  describe('ClikCode in VS Code', () => {
    let api: ClikCodeApi;

    before(async () => {
      api = await activate();
    });

    it('opens from the editor title button into the secondary side bar', async () => {
      const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode')!;
      const contributes = extension.packageJSON.contributes;
      assert.ok((contributes.menus['editor/title'] as Array<{ command: string }>).some((item) => item.command === 'clikcode.open'), 'the editor title bar has the button');
      assert.ok(contributes.viewsContainers.secondarySidebar.some((item: { id: string }) => item.id === 'clikcode-secondary'), 'the chat is a secondary side bar view');
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder!.uri, 'hello.ts'));
      await vscode.commands.executeCommand('clikcode.open');
      await api.ready();
      const model = await until(api, (state) => state.connection === 'ready' && Boolean(state.sessionId), 'a chat to open');
      assert.strictEqual(model.workspace, process.env.CLIKCODE_IT_WORKSPACE);
      assert.ok((model.revision ?? 0) >= 2, 'the bridge speaks revision 2');
      await waitFor(api, '#composer-input', 'the composer in the side bar');
      await waitFor(api, '.welcome', 'the welcome screen');
    });

    it('chooses a harness and a model from the composer menu', async () => {
      await pickProviderModel(api, 'opencode', 'opencode/big-pickle');
      await until(api, (state) => state.harness === 'opencode' && state.model === 'opencode/big-pickle', 'OpenCode big-pickle', 180_000);
      await waitFor(api, '#provider-button', 'the provider button showing OpenCode', 30_000, (found) => /OpenCode/.test(found.text));
      // The provider is on the button beside it, so the model reads without it.
      await waitFor(api, '#model-button', 'the Model button showing big-pickle', 30_000, (found) => found.text.trim() === 'big-pickle');
      await waitFor(api, '.welcome', 'the welcome line naming big-pickle', 30_000, (found) => /OpenCode · big-pickle/.test(found.text) && !/opencode\//.test(found.text));
    });

    it('runs a real turn typed in the composer and streams the answer', async () => {
      let sawRunning = false;
      const watch = api.onDidChange((state) => { if (state.running) sawRunning = true; });
      await type(api, '#composer-input', 'Reply with exactly the word PONG and nothing else.');
      await waitFor(api, '#send-button', 'enabled Send button', 10_000, (found) => found.count > 0 && !found.disabled);
      await click(api, '#send-button');
      const done = await until(api, (state) => !state.running && state.messages.some((m) => m.role === 'assistant' && /PONG/.test(m.content)), 'the answer', 240_000);
      watch.dispose();
      assert.ok(sawRunning, 'the chat showed the turn running');
      assert.deepStrictEqual(done.messages.map((m) => m.role), ['user', 'assistant']);
      assert.strictEqual(done.messages[0]!.content, 'Reply with exactly the word PONG and nothing else.');
      await waitFor(api, '.message.assistant', 'the answer on the page', 10_000, (found) => found.texts.some((text) => /PONG/.test(text)));
      await screenshot('turn');
    });

    it('drives the provider and model menus from the keyboard', async () => {
      // A panel left hidden by the turn before must not fail this test for the wrong reason.
      await vscode.commands.executeCommand('clikcode.focus');
      await waitFor(api, '#provider-button', 'the composer');
      await click(api, '#provider-button');
      await waitFor(api, '#provider-picker [data-key="p:opencode"]', 'the provider list');
      assert.strictEqual((await query(api, '#provider-picker [data-key^="m:"]')).count, 0, 'the Provider menu lists providers only');
      await type(api, '#provider-picker input', 'opencode');
      await waitFor(api, '#provider-picker [data-key="p:opencode"][data-active="true"]', 'OpenCode highlighted');
      await key(api, '#provider-picker input', 'Enter');
      await waitFor(api, '#provider-picker', 'the menu to close on Enter', 10_000, (found) => found.count === 0);
      await click(api, '#model-button');
      await waitFor(api, '#model-picker [data-key="m:opencode/big-pickle"]', "OpenCode's models in the Model menu", 60_000);
      const labels = await query(api, '#model-picker .row-label');
      assert.ok(labels.texts.includes('big-pickle'), `big-pickle listed by its label: ${labels.texts.slice(0, 5).join(', ')}`);
      assert.ok(!labels.texts.some((text) => /^opencode[/:]/.test(text)), 'no row repeats the provider');
      await key(api, '#model-picker input', 'Escape');
      await waitFor(api, '#model-picker', 'the menu to close on Esc', 10_000, (found) => found.count === 0);
      assert.strictEqual(api.state.running, false, 'Esc in a menu does not touch the turn');
    });

    it('stops a running turn with Esc and keeps the chat usable', async () => {
      await type(api, '#composer-input', 'Count slowly from 1 to 400, one number per line.');
      await click(api, '#send-button');
      await until(api, (state) => state.running, 'the turn to start', 120_000);
      await key(api, '#composer-input', 'Escape');
      const stopped = await until(api, (state) => !state.running, 'the turn to stop', 120_000);
      assert.ok(stopped.connection === 'ready');
      await waitFor(api, '#composer-input', 'the composer', 10_000, (found) => !found.disabled);
    });

    it('shows a command result as a panel', async () => {
      const before = api.state.notes.length;
      await api.send('/help');
      const model = await until(api, (state) => state.notes.length > before, 'the /help panel');
      assert.strictEqual(model.notes[model.notes.length - 1]!.title, 'Commands');
      await waitFor(api, '.panel-card', 'the panel on the page');
    });

    it('adds the editor selection to the chat from the editor context and sends it', async () => {
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder!.uri, 'hello.ts'));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(0, 0, 0, document.lineAt(0).text.length);
      const menu = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode')!.packageJSON.contributes.menus['editor/context'] as Array<{ command: string }>;
      assert.ok(menu.some((item) => item.command === 'clikcode.addToChat'), 'Add to ClikCode Chat is on the editor context menu');
      await vscode.commands.executeCommand('clikcode.addToChat');
      await waitFor(api, '.attachment', 'the selection chip', 10_000, (found) => /hello\.ts:1/.test(found.text));
      const count = api.state.messages.length;
      await type(api, '#composer-input', 'What is the name of the exported constant? Answer with just the name.');
      await click(api, '#send-button');
      const done = await until(api, (state) => !state.running && state.messages.length >= count + 2, 'the answer about the selection', 240_000);
      const [question, answer] = done.messages.slice(-2);
      assert.match(question!.content, /`hello\.ts` line 1:\n```typescript\nexport const greeting/);
      assert.match(answer!.content, /greeting/);
    });

    it('resumes a conversation from the history list', async () => {
      const previous = api.state.sessionId!;
      await api.open('new');
      await until(api, (state) => Boolean(state.sessionId) && state.sessionId !== previous, 'a new chat');
      await click(api, '#history-button');
      await waitFor(api, `#history-list [data-key="${previous}"]`, 'the earlier conversation in the list');
      await click(api, `#history-list [data-key="${previous}"]`);
      const resumed = await until(api, (state) => state.sessionId === previous, 'the earlier conversation to open');
      assert.ok(resumed.messages.some((m) => /PONG/.test(m.content)), 'its transcript came back');
      await waitFor(api, '#composer-input', 'the chat screen again');
    });

    it('opens a new tab with a conversation of its own', async () => {
      const sidebarSession = api.state.sessionId;
      await vscode.commands.executeCommand('clikcode.openInNewTab');
      assert.strictEqual(api.tabs, 1);
      const deadline = Date.now() + 120_000;
      while (!api.tabStates()[0]?.sessionId && Date.now() < deadline) await sleep(500);
      const tab = api.tabStates()[0]!;
      assert.strictEqual(tab.connection, 'ready');
      assert.ok(tab.sessionId && tab.sessionId !== sidebarSession, 'the tab has its own conversation');
      assert.strictEqual(api.state.sessionId, sidebarSession, 'the side bar kept its own');
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('clikcode.chatEditor'));
      await vscode.window.tabGroups.close(tabs);
      await sleep(500);
      assert.strictEqual(api.tabs, 0);
      await vscode.commands.executeCommand('clikcode.open');
      await sleep(500);
    });

    it('asks before an edit, with the change in a diff editor, and applies it when allowed', async function () {
      // ClikCode's own agent (ClikDeploy Gateway) asks in `ask` mode; it runs
      // only where this machine is signed in to the Gateway.
      await vscode.commands.executeCommand('clikcode.open');
      await waitFor(api, '#provider-button', 'the chat panel');
      await openProviderList(api);
      const row = await waitFor(api, '#provider-picker [data-key="p:gateway"]', 'the Gateway row');
      await api.probe('key', '#provider-picker input', 'Escape');
      if (/sign in/.test(row.text)) this.skip();
      await pickProviderModel(api, 'gateway', 'gpt-5.6-luna').catch(async () => {
        await type(api, '#model-picker input', '');
        await click(api, '#model-picker [data-key="m:auto"]');
      });
      await until(api, (state) => state.providerId === 'gateway', 'the Gateway route', 60_000);
      if (api.state.permissions !== 'ask') {
        await api.send('/permissions ask');
        await until(api, (state) => state.permissions === 'ask', 'ask mode');
      }
      await api.send('Create a file named notes.txt in the workspace containing exactly the line: hello from ClikCode. Use your file tool; do not ask me anything first.');
      const asking = await until(api, (state) => state.approvals.length > 0, 'an approval request', 240_000);
      await waitFor(api, '.approval', 'the approval card');
      await sleep(1_500);
      assert.ok(asking.approvals[0]!.hasDiff, 'the approval carries the change');
      const diffTab = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'clikcode-diff');
      assert.ok(diffTab, 'the proposed change is open in a diff editor');
      const proposed = (diffTab!.input as vscode.TabInputTextDiff).modified;
      const after = (await vscode.workspace.openTextDocument(proposed)).getText();
      assert.match(after, /hello from ClikCode/, 'the diff shows the proposed file');
      // Accepted from the diff editor's title bar, as a user would.
      await vscode.commands.executeCommand('clikcode.acceptProposedDiff', proposed);
      // A model may make a second edit after its first approved write. Keep
      // answering distinct requests so the test covers the whole turn.
      const seen = new Set([asking.approvals[0]!.id]);
      const deadline = Date.now() + 240_000;
      for (;;) {
        const state = await until(api, (current) => !current.running || current.approvals.some((approval) => !seen.has(approval.id)), 'the turn to finish or ask again', Math.max(1, deadline - Date.now()));
        if (!state.running) break;
        const next = state.approvals.find((approval) => !seen.has(approval.id))!;
        seen.add(next.id);
        await waitFor(api, '.approval [data-approve="yes"]', 'the next approval button');
        await click(api, '.approval [data-approve="yes"]');
      }
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      const written = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder!.uri, 'notes.txt')).then((bytes) => Buffer.from(bytes).toString('utf8'), () => '');
      assert.match(written, /hello from ClikCode/);
    });

    it('reconnects on its own when ClikCode stops underneath it', async () => {
      const session = api.state.sessionId;
      const bridges = (): number[] => {
        try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'ide-bridge'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
      };
      const [pid] = bridges();
      assert.ok(pid, 'the side bar bridge is a child of the extension host');
      process.kill(pid!, 'SIGKILL');
      await until(api, (state) => state.connection !== 'ready', 'the chat to notice', 30_000);
      const back = await until(api, (state) => state.connection === 'ready' && Boolean(state.sessionId), 'the chat to reconnect', 90_000);
      assert.strictEqual(back.sessionId, session, 'it came back to the same conversation');
      assert.notStrictEqual(bridges()[0], pid, 'on a new bridge');
      await waitFor(api, '.banner', 'no error banner', 10_000, (found) => found.count === 0);
    });

    it('offers an update when ClikCode is too old for the extension, or the extension for ClikCode', async () => {
      const settings = () => vscode.workspace.getConfiguration('clikcode');
      const original = settings().inspect<string>('path')?.globalValue;
      const dir = mkdtempSync(join(tmpdir(), 'clikcode-it-compat-'));
      const fake = (name: string, body: string): string => { const path = join(dir, name); writeFileSync(path, body); return path; };
      const noBridge = fake('no-bridge.js', `process.stderr.write("error: unknown command 'ide-bridge'\\n"); process.exit(1);`);
      const oldBridge = fake('old-bridge.js', `process.send({ type: 'ready', version: '0.9.0', pid: process.pid }); process.on('message', (m) => { if (m.type === 'close') process.exit(0); });`);
      const newBridge = fake('new-bridge.js', `process.send({ type: 'ready', version: '9.0.0', protocol: 999, pid: process.pid }); process.on('message', (m) => { if (m.type === 'close') process.exit(0); });`);
      try {
        // Alternating, so each one's offer is a change the test sees.
        const missing = join(dir, 'not-installed', 'index.js');
        for (const [entry, remedy] of [[missing, 'install'], [noBridge, 'update-clikcode'], [newBridge, 'update-extension'], [oldBridge, 'update-clikcode']] as const) {
          await settings().update('path', entry, vscode.ConfigurationTarget.Global);
          const model = await until(api, (state) => state.remedy === remedy, `the ${remedy} offer for ${entry}`);
          assert.strictEqual(model.connection, 'error');
          if (remedy === 'install') assert.match(model.connectionError ?? '', /not a ClikCode installation/);
          else if (remedy === 'update-clikcode') assert.match(model.connectionError ?? '', /npm install -g clikcode@latest/);
          else assert.match(model.connectionError ?? '', /Update the ClikCode extension/);
        }
        await waitFor(api, '.banner', 'the banner on the page');
      } finally {
        await settings().update('path', original, vscode.ConfigurationTarget.Global);
      }
      await until(api, (state) => state.connection === 'ready' && !state.remedy, 'the real ClikCode to reconnect');
    });
  });
}
