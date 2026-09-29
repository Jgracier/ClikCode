/** The screenshot tour: the real VS Code, the real ClikCode, demo accounts.
 * Each step waits for what it shows, then captures the screen. */
import * as vscode from 'vscode';
import type { ClikCodeApi } from '../../../src/extension';
import { execFileSync } from 'node:child_process';
import { activate, click, openProviderList, pickProviderModel, screenshot, sleep, type, until, waitFor } from './helpers';

/** The secondary side bar's left edge: one row of the screen, scanned from
 * the right for the 1px border line between it and the editor. */
function sidebarEdge(): number | undefined {
  const y = 720;
  const row = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1440x1', '-i', `${process.env.DISPLAY}+0,${y}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000 });
  const at = (x: number): string => `${row[x * 3]},${row[x * 3 + 1]},${row[x * 3 + 2]}`;
  // The border is one pixel wide, and the side bar's empty background runs
  // on from it; the editor's scrollbar before it is a shorter run.
  for (let x = 700; x < 1400; x += 1) {
    if (at(x - 1) === at(x) || at(x) === at(x + 1)) continue;
    let run = 1;
    while (run < 40 && at(x + 1 + run) === at(x + 1)) run += 1;
    if (run >= 20) return x;
  }
  return undefined;
}

/** Drags the sash left of the side bar to `x`, as someone working in it would. */
async function dragSidebarTo(x: number): Promise<void> {
  try {
    const edge = sidebarEdge();
    if (!edge) return;
    execFileSync('xdotool', ['mousemove', String(edge), '450', 'sleep', '0.4', 'mousedown', '1', 'sleep', '0.3',
      'mousemove', String(Math.round((edge + x) / 2)), '450', 'sleep', '0.2', 'mousemove', String(x), '450', 'sleep', '0.3', 'mouseup', '1',
      'mousemove', '700', '850']);
  } catch { /* no xdotool or ffmpeg: the default width */ }
  await sleep(800);
}

export function screensSuite(): void {
  describe('screenshots', () => {
    let api: ClikCodeApi;

    before(async () => {
      api = await activate();
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder!.uri, 'math.ts'));
      await vscode.commands.executeCommand('workbench.action.closePanel');
      // Where ClikCode is before it is opened: the button in the editor's title bar.
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await screenshot('placement', 2_000);
      await vscode.commands.executeCommand('clikcode.open');
      await api.ready();
      await until(api, (state) => state.connection === 'ready' && Boolean(state.sessionId) && Boolean(state.provider), 'a chat', 90_000);
      // A wider side bar, as someone working in it would drag it.
      // A wider side bar, as someone working in it would drag it: the sash
      // between the editor and the secondary side bar, dragged with the mouse.
      await dragSidebarTo(Number(process.env.CLIKCODE_IT_SIDEBAR_X ?? 960));
      await vscode.commands.executeCommand('clikcode.focus');
    });

    it('welcome', async () => {
      await waitFor(api, '.welcome', 'the welcome screen');
      await screenshot('welcome', 2_000);
    });

    it('provider and model menu', async () => {
      await click(api, '#provider-button');
      await waitFor(api, '#provider-picker', 'the menu');
      await screenshot('picker-models-current');
      await openProviderList(api);
      await screenshot('picker');
      await type(api, '#provider-picker input', 'opencode');
      await click(api, '#provider-picker [data-key="p:opencode"]');
      await waitFor(api, '#provider-picker [data-key="m:opencode/big-pickle"]', 'OpenCode models', 120_000);
      await screenshot('picker-models');
      await api.probe('key', '#provider-picker input', 'Escape');
      await pickProviderModel(api, 'opencode', 'opencode/big-pickle');
      await until(api, (state) => state.model === 'opencode/big-pickle', 'big-pickle', 180_000);
    });

    it('a turn with tool activity', async () => {
      await type(api, '#composer-input', 'Read math.ts and README.md, then explain in three short bullet points what mean() does and one edge case it gets wrong.');
      await click(api, '#send-button');
      await until(api, (state) => (state.live?.activities.length ?? 0) >= 1, 'tool activity', 240_000).catch(() => undefined);
      await screenshot('streaming', 600);
      await until(api, (state) => !state.running && state.messages.length >= 2, 'the answer', 300_000);
      await screenshot('turn-folded');
      // The steps it took, unfolded: each tool row, its file a link.
      await waitFor(api, '.trace-toggle', 'the steps row');
      await click(api, '.trace-toggle');
      await screenshot('turn');
    });

    it('an approval with its diff', async function () {
      await openProviderList(api);
      const row = await waitFor(api, '#provider-picker [data-key="p:gateway"]', 'the Gateway row');
      await api.probe('key', '#provider-picker input', 'Escape');
      if (/sign in/.test(row.text)) this.skip();
      await api.open('new');
      await sleep(1_500);
      await pickProviderModel(api, 'gateway', 'gpt-5.6-luna');
      await until(api, (state) => state.providerId === 'gateway', 'the Gateway', 60_000);
      if (api.state.permissions !== 'ask') await api.send('/permissions ask');
      await type(api, '#composer-input', 'Add an exported function median(values: number[]) to math.ts. Edit the file directly with your edit tool.');
      await click(api, '#send-button');
      await until(api, (state) => state.approvals.length > 0, 'an approval', 300_000);
      await waitFor(api, '.approval', 'the approval card');
      await screenshot('approval', 2_500);
      await click(api, '.approval [data-approve="yes"]');
      await until(api, (state) => !state.running, 'the turn', 300_000).catch(() => undefined);
    });

    it('conversations', async () => {
      await vscode.commands.executeCommand('clikcode.showHistory');
      await waitFor(api, '#history-list .conversation', 'conversations');
      await screenshot('history');
    });

    it('accounts and usage', async () => {
      await vscode.commands.executeCommand('clikcode.showAccounts');
      await waitFor(api, '.account', 'accounts');
      await sleep(2_500);
      await screenshot('accounts');
    });

    it('a narrow side bar', async () => {
      // The sash is found by the plain editor's colours: no diff editor open.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder!.uri, 'math.ts'));
      await vscode.commands.executeCommand('clikcode.showHistory');
      await click(api, '#history-button');
      await dragSidebarTo(1440 - 300);
      await waitFor(api, '#composer-input', 'the chat');
      await screenshot('narrow');
      await click(api, '#provider-button');
      await waitFor(api, '#provider-picker', 'the menu');
      await screenshot('narrow-picker');
      await api.probe('key', '#provider-picker input', 'Escape');
      await dragSidebarTo(Number(process.env.CLIKCODE_IT_SIDEBAR_X ?? 960));
    });

    it('settings', async () => {
      await vscode.commands.executeCommand('clikcode.openSettings');
      await waitFor(api, '.sheet .keylist-row', 'the settings sheet', 60_000);
      await screenshot('settings');
      await api.probe('key', '.sheet input', 'Escape');
    });
  });
}
