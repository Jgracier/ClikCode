/** Add or remove an ACP harness from VS Code. The CLI owns the file; this
 * only asks for the fields and runs `clikcode acp`. The provider list rereads
 * that file, so the next menu shows the change. */

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveRuntime } from './runtime';
import { parseAcpArguments } from './acp-arguments';

async function clikcode(args: readonly string[]): Promise<string> {
  const settings = vscode.workspace.getConfiguration('clikcode');
  const runtime = await resolveRuntime({ path: settings.get<string>('path'), nodePath: settings.get<string>('nodePath') });
  return await new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.entry, '--json', ...args], { env: { ...process.env, ...runtime.env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || out.trim() || `clikcode exited ${code}`));
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCustomAcpCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clikcode.addAcpHarness', async () => {
      const command = await vscode.window.showInputBox({ title: 'Add ACP harness', prompt: 'Command name', placeHolder: 'my-agent', ignoreFocusOut: true });
      if (!command) return;
      const binary = await vscode.window.showInputBox({ title: 'Add ACP harness', prompt: 'Executable', placeHolder: 'my-agent', ignoreFocusOut: true });
      if (!binary) return;
      const flags = await vscode.window.showInputBox({ title: 'Add ACP harness', prompt: 'ACP launch arguments as a JSON array', placeHolder: '["--stdio"]', ignoreFocusOut: true });
      if (flags === undefined) return;
      const name = await vscode.window.showInputBox({ title: 'Add ACP harness', prompt: 'Name in the provider list', placeHolder: command, ignoreFocusOut: true });
      try {
        const argv = ['acp', 'add'];
        if (name?.trim()) argv.push('--name', name.trim());
        argv.push(command.trim(), binary.trim(), '--', ...parseAcpArguments(flags));
        await clikcode(argv);
        void vscode.window.showInformationMessage(`${name?.trim() || command.trim()} is in the provider list.`);
      } catch (error) {
        void vscode.window.showErrorMessage(messageOf(error));
      }
    }),
    vscode.commands.registerCommand('clikcode.removeAcpHarness', async () => {
      let listed: { command?: string; displayName?: string }[];
      try {
        const out = await clikcode(['acp', 'list']);
        const parsed = JSON.parse(out) as { harnesses?: { command?: string; displayName?: string }[] };
        listed = parsed.harnesses ?? [];
      } catch (error) {
        void vscode.window.showErrorMessage(messageOf(error));
        return;
      }
      if (!listed.length) {
        void vscode.window.showInformationMessage('No ACP harnesses have been added.');
        return;
      }
      const pick = await vscode.window.showQuickPick(listed.map((item) => ({
        label: item.displayName || item.command || 'ACP harness',
        description: item.command,
        command: item.command,
      })), { title: 'Remove ACP harness', ignoreFocusOut: true });
      if (!pick?.command) return;
      try {
        await clikcode(['acp', 'remove', pick.command]);
        void vscode.window.showInformationMessage(`${pick.label} was removed.`);
      } catch (error) {
        void vscode.window.showErrorMessage(messageOf(error));
      }
    }),
  );
}
