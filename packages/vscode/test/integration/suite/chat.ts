/** ClikCode in VS Code, end to end: VS Code -> the extension's page ->
 * `clikcode ide-bridge` -> session worker -> a vendor harness (OpenCode's
 * free model) and back, driven through the page the way a user drives it. */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ClikCodeApi } from '../../../src/extension';
import { activate, click, key, openProviderList, paste, pickProviderModel, query, screenshot, sleep, type, until, waitFor } from './helpers';

export function chatSuite(): void {
  describe('ClikCode in VS Code', () => {
    let api: ClikCodeApi;

    before(async () => {
      api = await activate();
    });

    it('opens into the secondary side bar', async () => {
      const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode')!;
      const contributes = extension.packageJSON.contributes;
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
      await screenshot('welcome', 1500);
    });

    it('updates the open conversation list when another ClikCode process changes a chat', async () => {
      await click(api, '#history-button');
      // Loaded, so a later change can only arrive by being told of it.
      await waitFor(api, '#history-list [data-key], #history-list .keylist-empty', 'the conversation list, loaded');
      await sleep(500);
      // Another process: the CLI this extension runs, against the same home.
      const entry = vscode.workspace.getConfiguration('clikcode').get<string>('path')!;
      const clikcode = (...args: string[]): string => execFileSync('node', [entry, ...args], { encoding: 'utf8', env: process.env });
      const id = (JSON.parse(clikcode('sessions', 'create', '--route', 'gateway')) as { session: { id: string } }).session.id;
      clikcode('sessions', 'command', id, '/rename', 'Named in another window');
      // Well inside the 10s fallback poll, and nothing is generating: only the
      // file watch can bring it in this fast.
      await waitFor(api, `#history-list [data-key="${id}"]`, 'the chat named elsewhere, without reopening the list', 5_000, (found) => /Named in another window/.test(found.text));
      await click(api, '#history-button');
      await waitFor(api, '#composer-input', 'the chat screen again');
    });

    it('walks /search mention by mention, as the terminal does', async () => {
      const entry = vscode.workspace.getConfiguration('clikcode').get<string>('path')!;
      const clikcode = (...args: string[]): string => execFileSync('node', [entry, ...args], { encoding: 'utf8', env: process.env });
      const id = (JSON.parse(clikcode('sessions', 'create', '--route', 'gateway')) as { session: { id: string } }).session.id;
      clikcode('sessions', 'command', id, '/rename', 'Zanzibar parser notes');
      // A transcript message without a vendor turn: a shell line's output.
      clikcode('sessions', 'command', id, '!echo the zanzibar parser is done');
      const from = api.state.sessionId;
      await api.send('/search zanzibar');
      // The conversation opens in the panel at the mention, with the terminal's status line and keys.
      await waitFor(api, '.search-bar', 'the search bar', 30_000, (found) => /mention 1 of \d+.*esc done/.test(found.text));
      await until(api, (state) => state.sessionId === id, 'the conversation the search found');
      await screenshot('search-walk', 800);
      await key(api, '.search-bar', 'Escape');
      await waitFor(api, '.search-bar', 'the walk over', 10_000, (found) => found.count === 0);
      assert.notStrictEqual(id, from);
      assert.strictEqual(api.state.sessionId, id, 'the walk ends on the conversation it showed');
    });

    it('lists only this provider\'s accounts, and sets effort beside the model', async () => {
      await waitFor(api, '#account-button', 'the account under the message box');
      await click(api, '#account-button');
      await waitFor(api, '#account-menu [role="option"], #account-menu .keylist-empty, #account-menu .row', 'the account list', 30_000, (found) => found.count > 0);
      await screenshot('accounts-menu', 600);
      // Title and Add account name the same provider: the chat's, as the
      // bridge reads it. Built from two sources, the menu once titled itself
      // Copilot and added a Grok account.
      const shownName = (await query(api, '#provider-button')).text.trim();
      const title = (await waitFor(api, '#account-menu .menu-title', 'the account menu title', 30_000, (found) => found.count > 0 && found.text.trim() !== 'Accounts')).text.trim();
      if (shownName && !shownName.toLowerCase().includes(title.toLowerCase())) throw new Error(`account menu titled "${title}" on a chat showing "${shownName}"`);
      await waitFor(api, '#account-menu [data-key="add"]', 'Add account for the chat\'s provider');
      await key(api, '#account-menu', 'Escape');
      if ((await query(api, '#model-button')).count) {
        await click(api, '#model-button');
        await waitFor(api, '#model-picker', 'the model picker');
        await screenshot('model-picker', 1500);
        await key(api, '#model-picker', 'Escape');
      }
      await click(api, '#history-button');
      await waitFor(api, '#history-menu', 'the conversations list');
      await screenshot('history-menu', 800);
      await key(api, '#history-menu', 'Escape');
      await click(api, '#more-button');
      await waitFor(api, '#more-menu', 'the More menu');
      await screenshot('more-menu', 500);
      await key(api, '#more-menu', 'Escape');
      // Accounts & usage is the account menu, with the full list one row away.
      await vscode.commands.executeCommand('clikcode.showAccounts');
      await waitFor(api, '#account-menu [data-key="all"]', 'the account menu, from the command');
      await key(api, '#account-menu', 'Escape');
      await api.send('/settings');
      await waitFor(api, '.sheet', 'the settings sheet', 30_000);
      await screenshot('settings', 1000);
      await key(api, '.sheet', 'Escape');
      await waitFor(api, '#composer-input', 'back to the chat');
    });

    it('signs in inside the panel: a link card with its code, a masked key sheet, never a terminal', async () => {
      const opened = (): string[] => (existsSync(process.env.CLIKCODE_IT_OPENED!) ? readFileSync(process.env.CLIKCODE_IT_OPENED!, 'utf8').trim().split('\n').filter(Boolean) : []);
      const path = process.env.PATH;
      process.env.PATH = `${process.env.CLIKCODE_IT_FAKE_BIN}:${path ?? ''}`;
      await vscode.commands.executeCommand('clikcode.restart');
      await api.ready();
      try {
      const terminals = vscode.window.terminals.length;
      await api.send('/accounts add grok');
      const code = await waitFor(api, '#sign-in-link [data-code]', 'the sign-in card with its code', 30_000);
      if (code.text.trim() !== 'AB12-CD34') throw new Error(`the card shows code "${code.text}"`);
      await screenshot('sign-in-card', 300);
      await waitFor(api, '#sign-in-link', 'the card gone once signed in', 30_000, (found) => found.count === 0);
      if (vscode.window.terminals.length !== terminals) throw new Error('a terminal opened for a link sign-in');
      const links = opened();
      if (links.length !== 1 || links[0] !== 'https://accounts.x.ai/oauth2/device?user_code=AB12-CD34') throw new Error(`opened: ${JSON.stringify(links)}`);

      // Cancel ends it: the vendor is held waiting, the card's Cancel stops it.
      writeFileSync(process.env.CLIKCODE_IT_HOLD!, '');
      try {
        await api.send('/accounts add grok');
        await waitFor(api, '#sign-in-link [data-cancel]', 'the second sign-in card', 30_000);
        await click(api, '#sign-in-link [data-cancel]');
        await waitFor(api, '#sign-in-link', 'the card gone once cancelled', 15_000, (found) => found.count === 0);
      } finally { rmSync(process.env.CLIKCODE_IT_HOLD!, { force: true }); }
      if (vscode.window.terminals.length !== terminals) throw new Error('a terminal opened for a link sign-in');

      // A sign-in that asks for a key: ClikCode's own input sheet, masked.
      process.env.FAKE_LOGIN_KEY = 'sk-test-42';
      await vscode.commands.executeCommand('clikcode.restart');
      await api.ready();
      await api.send('/accounts add grok');
      const field = await waitFor(api, '.sheet input#sheet-input', 'the key sheet', 30_000);
      if (!/API key/i.test((await query(api, '.sheet .sheet-title')).text)) throw new Error(`the sheet asks "${(await query(api, '.sheet .sheet-title')).text}"`);
      if ((await api.probe('query', '.sheet input#sheet-input[type="password"]') as { count: number }).count !== 1) throw new Error(`the key field is not masked: ${JSON.stringify(field)}`);
      await screenshot('sign-in-key-sheet', 300);
      await type(api, '.sheet input#sheet-input', 'sk-test-42');
      await click(api, '.sheet button[type="submit"]');
      await waitFor(api, '#sign-in-link', 'the card gone once signed in with the key', 30_000, (found) => found.count === 0);
      if (vscode.window.terminals.length !== terminals) throw new Error('a terminal opened for a key sign-in');
      } finally {
        delete process.env.FAKE_LOGIN_KEY;
        process.env.PATH = path;
        await vscode.commands.executeCommand('clikcode.restart');
        await api.ready();
        // Connected again before the next test clicks anything.
        await waitFor(api, '#provider-button', 'the provider button, enabled again', 60_000, (found) => found.count > 0 && !found.disabled);
      }
    });

    it('chooses a harness and a model from the composer menu', async () => {
      await pickProviderModel(api, 'opencode', 'opencode/big-pickle');
      await until(api, (state) => state.harness === 'opencode' && state.model === 'opencode/big-pickle', 'OpenCode big-pickle', 180_000);
      await waitFor(api, '#provider-button', 'the provider button showing OpenCode', 30_000, (found) => /OpenCode/.test(found.text));
      // The provider is on the button beside it, so the model reads without it.
      // The model and its effort read as one choice: `big-pickle`, or `big-pickle Medium`.
      await waitFor(api, '#model-button', 'the Model button showing big-pickle', 30_000, (found) => /^big-pickle( \w+)?$/.test(found.text.trim()));
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
      // The open file goes with the message as context, shown as a chip, not as text the user typed.
      assert.match(done.messages[0]!.content, /^Reply with exactly the word PONG and nothing else\.(\n\nOpen in the editor: `[^`]+`)?$/);
      await waitFor(api, '.message.user .bubble', 'the prompt on the page', 10_000, (found) => found.texts.some((text) => text.startsWith('Reply with exactly the word PONG and nothing else.') && !text.includes('Open in the editor')));
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

    it('keeps a running turn on Esc, stops it with the stop button, and keeps the chat usable', async () => {
      await type(api, '#composer-input', 'Count slowly from 1 to 400, one number per line.');
      await click(api, '#send-button');
      await until(api, (state) => state.running, 'the turn to start', 120_000);
      await screenshot('live', 2500);
      // Esc only takes back a waiting message: with none it touches nothing.
      await key(api, '#composer-input', 'Escape');
      await sleep(1_500);
      assert.strictEqual(api.state.running, true, 'Esc does not stop the turn');
      await click(api, '#stop-button');
      const before = { harness: api.state.harness, model: api.state.model };
      const stopped = await until(api, (state) => !state.running, 'the turn to stop', 120_000);
      assert.ok(stopped.connection === 'ready');
      // Stopping a turn is not a change of provider: the chat stays on it.
      await sleep(1_500);
      assert.deepStrictEqual({ harness: api.state.harness, model: api.state.model }, before, 'the chat kept its provider and model');
      await waitFor(api, '#composer-input', 'the composer', 10_000, (found) => !found.disabled);
    });

    it('shows a command result as a panel', async () => {
      const before = api.state.notes.length;
      await api.send('/help');
      const model = await until(api, (state) => state.notes.length > before, 'the /help panel');
      assert.strictEqual(model.notes[model.notes.length - 1]!.title, 'Commands');
      await waitFor(api, '.panel-card', 'the panel on the page');
      await screenshot('panel', 600);
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

    it('turns pasted lines copied from a file into a reference, and leaves other text as typed', async () => {
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder!.uri, 'math.ts'));
      const editor = await vscode.window.showTextDocument(document);
      // Selecting is not sending: nothing appears in the chat for it.
      editor.selection = new vscode.Selection(0, 0, 2, 1);
      await sleep(500);
      assert.strictEqual((await query(api, '.attachment')).count, 0, 'a selection alone attaches nothing');
      await type(api, '#composer-input', '');
      await paste(api, '#composer-input', document.getText(editor.selection));
      await waitFor(api, '.attachment', 'the reference chip', 10_000, (found) => /math\.ts:1-3/.test(found.text));
      assert.strictEqual((await query(api, '#composer-input')).value, '', 'the lines are a reference, not pasted text');
      await paste(api, '#composer-input', 'just some\nnotes');
      await waitFor(api, '#composer-input', 'other text pasted as typed', 10_000, (found) => found.value === 'just some\nnotes');
      await type(api, '#composer-input', '');
      await click(api, '.attachment button');
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
      // As many as wanted: the ClikCode button in the editor's tab bar opens
      // another each time, from a text editor or from a ClikCode tab.
      const menu = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode')!.packageJSON.contributes.menus['editor/title'] as Array<{ command: string }>;
      assert.ok(menu.some((item) => item.command === 'clikcode.newChatTab'), 'the ClikCode button is in the editor tab bar');
      await vscode.commands.executeCommand('clikcode.newChatTab');
      await vscode.commands.executeCommand('clikcode.newChatTab');
      assert.strictEqual(api.tabs, 3, 'three chat tabs');
      const groups = new Set(vscode.window.tabGroups.all.filter((group) => group.tabs.some((item) => item.input instanceof vscode.TabInputWebview && item.input.viewType.endsWith('clikcode.chatEditor'))).map((group) => group.viewColumn));
      assert.strictEqual(groups.size, 1, 'the chat tabs share one editor group');
      const chatTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('clikcode.chatEditor'));
      // The editor's tab list catches up with new panels a moment later.
      for (const shownBy = Date.now() + 10_000; chatTabs().length < 3 && Date.now() < shownBy;) await sleep(200);
      const tabs = chatTabs();
      assert.strictEqual(tabs.length, 3, 'three chat tabs in the editor');
      await screenshot('tabs');
      await vscode.window.tabGroups.close(tabs);
      for (const closeBy = Date.now() + 10_000; api.tabs && Date.now() < closeBy;) await sleep(200);
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
      assert.ok(asking.approvals[0]!.diff?.length, 'the approval carries the change');
      const diffTab = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'clikcode-diff');
      assert.ok(diffTab, 'the proposed change is open in a diff editor');
      const proposed = (diffTab!.input as vscode.TabInputTextDiff).modified;
      const after = (await vscode.workspace.openTextDocument(proposed)).getText();
      assert.match(after, /hello from ClikCode/, 'the diff shows the proposed file');
      await screenshot('approval');
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
      await screenshot('edited');
    });

    it('brings a question up beside the editor without taking the keyboard from it', async () => {
      await until(api, (state) => state.connection === 'ready' && !state.running, 'an idle chat', 60_000);
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder!.uri, 'hello.ts'));
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.window.showTextDocument(document, { preserveFocus: false });
      await sleep(500);
      const before = document.getText();
      // What the check below relies on: a key typed now reaches this editor.
      await vscode.commands.executeCommand('default:type', { text: 'z' });
      assert.notStrictEqual(document.getText(), before, 'typing reaches the focused editor');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      // A question the bridge asks while the user is in the editor.
      void api.send('/settings');
      await waitFor(api, '.sheet', 'the question in the chat', 30_000);
      await screenshot('question-beside-editor', 500);
      // The next key still lands in the editor, not in the question.
      await vscode.commands.executeCommand('default:type', { text: 'z' });
      const typed = document.getText();
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await key(api, '.sheet', 'Escape');
      await waitFor(api, '#composer-input', 'back to the chat');
      assert.notStrictEqual(typed, before, 'the editor kept the keyboard');
    });

    it('reconnects on its own when ClikCode stops underneath it', async () => {
      const session = api.state.sessionId;
      const bridges = (): number[] => {
        try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'ide-bridge'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
      };
      const [pid] = bridges();
      assert.ok(pid, 'the side bar bridge is a child of the extension host');
      const panels = api.state.notes.length;
      process.kill(pid!, 'SIGKILL');
      await until(api, (state) => state.connection !== 'ready', 'the chat to notice', 30_000);
      // Typed and sent while it reconnects: the box takes it, and the line
      // waits in it until the chat is back. A command, so no model turn.
      assert.ok(!(await query(api, '#composer-input')).disabled, 'the box takes typing while it reconnects');
      await type(api, '#composer-input', '/help');
      await click(api, '#send-button');
      const back = await until(api, (state) => state.connection === 'ready' && Boolean(state.sessionId), 'the chat to reconnect', 90_000);
      assert.strictEqual(back.sessionId, session, 'it came back to the same conversation');
      assert.notStrictEqual(bridges()[0], pid, 'on a new bridge');
      await until(api, (state) => state.notes.length > panels, 'the held /help to run', 30_000);
      await waitFor(api, '#composer-input', 'the box emptied by the send', 10_000, (found) => !found.value);
      await waitFor(api, '.banner', 'no error banner', 10_000, (found) => found.count === 0);
    });

    it('moves onto a new build while idle, so a message is never held up by the move', async () => {
      const bridges = (): number[] => {
        try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'ide-bridge'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
      };
      await until(api, (state) => state.connection === 'ready' && !state.running, 'an idle chat', 60_000);
      const before = bridges();
      // A reinstall: the entry the bridge runs changes on disk.
      const entry = vscode.workspace.getConfiguration('clikcode').get<string>('path')!;
      const now = new Date();
      utimesSync(entry, now, now);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && bridges().every((pid) => before.includes(pid))) await sleep(250);
      assert.ok(bridges().some((pid) => !before.includes(pid)), 'the bridge moved onto the new build by itself');
      await until(api, (state) => state.connection === 'ready', 'the chat ready on the new build', 60_000);
      // A send now goes straight out: no restart stands in front of it.
      const asked = api.state.messages.filter((message) => message.role === 'user').length;
      await type(api, '#composer-input', 'Reply with exactly the word PING and nothing else.');
      await waitFor(api, '#send-button', 'enabled Send button', 10_000, (found) => found.count > 0 && !found.disabled);
      const sentAt = Date.now();
      await click(api, '#send-button');
      // Out: running, or (a reply this short) already answered.
      await until(api, (state) => state.running || state.messages.filter((message) => message.role === 'user').length > asked, 'the message to go out', 10_000);
      assert.ok(Date.now() - sentAt < 10_000, `the message went out in ${Date.now() - sentAt} ms`);
      await until(api, (state) => !state.running && state.messages.some((message) => message.role === 'assistant' && /PING/.test(message.content)), 'the answer', 240_000);
      // Finished in view: nothing popped up about it.
      await waitFor(api, '.banner', 'no banner', 5_000, (found) => found.count === 0);
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
