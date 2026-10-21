/** The machine a chat lives on.
 *
 * A chat belongs to the machine that runs it: its folders, its processes,
 * its vendor CLIs and their sign-ins are that machine's. This editor is only
 * a view onto it. So everything a chat needs from "where it runs" goes
 * through one ChatMachine, and for a chat on another machine the editor
 * sends intent, never a fact of its own machine: a new chat names no folder
 * (the owning machine starts it in its own home), a resumed one names none
 * either (its saved workspace stands). The bridge on that machine resolves
 * the rest (src/ide/bridge.ts open).
 *
 * The interface is the whole list of things that differ between the two
 * kinds: a new one is a compile error in both implementations, not a
 * forgotten `if (remote)` somewhere in the controller. */
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRemoteInfo, remoteTerminalScript } from '../../../src/remote/install';
import { removeRemoteImage, uploadRemoteImage } from '../../../src/remote/image';
import type { RemoteMachine } from '../../../src/remote/machines';
import { sshArgv } from '../../../src/remote/ssh';
import type { BridgeEndpoint } from './bridge-client';
import { bridgePool } from './bridge-pool';
import { TIMEOUT } from './controller/requests';
import { mentionFromUri, pastedReference, searchWorkspaceFiles } from './mentions';
import type { IdeConversation, IdeEvent, IdeFeature, IdeRequest } from './protocol';
import { remoteDirectory } from './remote-directory';
import { resolveRuntime } from './runtime';
import { runInTerminal } from './ui';
import type { Mention } from './webview-protocol';

export type SignInEvent = Extract<IdeEvent, { type: 'sign-in' }>;
export type PastedReference = ReturnType<typeof pastedReference>;

export interface MachineConnection {
  bridge: BridgeEndpoint;
}

export interface ChatMachine {
  readonly kind: 'local' | 'remote';
  /** 'local', or the remote machine's id (machines.json). */
  readonly id: string;
  /** Shown beside the chat; none for this computer. */
  readonly name: string | undefined;
  /** Its files are this editor's own: diffs read them, undo edits them. */
  readonly filesHere: boolean;

  /** Whether a chat can be opened there now. */
  reachable(): Promise<boolean>;
  /** A connection to the ClikCode that runs this machine's chats. Throws
   * (RuntimeError for this computer) when there is none to be had. */
  connect(log: (line: string) => void): Promise<MachineConnection>;
  /** The folder an `open` names, or none: the owning machine decides. Never
   * this computer's folder for a chat on another machine. */
  workspaceForOpen(): string | undefined;
  /** The machine's conversations. `own` is the chat's connection, given when
   * this is the chat's machine (a running bridge to ask). */
  conversations(own?: () => Promise<BridgeEndpoint | undefined>): Promise<IdeConversation[]>;
  /** @-mention search, a paste that refers to files or lines, and dropped
   * URIs: all name files of this editor's workspace. */
  searchFiles(text: string): Promise<Mention[]>;
  pastedReference(text: string): PastedReference | undefined;
  mentionsFromUris(uris: readonly string[]): Mention[];
  /** A pasted image put where the chat's agent can read it; its path there. */
  stageImage(name: string, bytes: Buffer): Promise<string>;
  releaseImage(path: string): Promise<void>;
  /** A vendor's terminal sign-in, run on the machine whose vendor it is. */
  runSignIn(event: SignInEvent, bridge: BridgeEndpoint, workspace: string | undefined): Promise<void>;
  /** A path the chat names, in an editor; rejects with what to say instead. */
  openFile(path: string, options: { line?: number; workspace?: string; preview: boolean }): Promise<void>;
  /** Updates the ClikCode that runs this machine's chats -- this
   * computer's the way it was installed (`clikcode update`, which leaves a
   * developer checkout alone and says what to run), another machine's over
   * SSH to the commit this editor runs. Each step goes to `report`; resolves
   * with what to say, rejects naming the step that failed. */
  update(report: (line: string) => void): Promise<string>;
  dispose(): void;
}

/** The commit of the ClikCode this editor runs (its `remote-info`): what
 * other machines are kept at. Undefined for a build with none. */
export async function localClikcodeCommit(): Promise<string | undefined> {
  const runtime = await resolveRuntime({ path: settings().get<string>('path'), nodePath: settings().get<string>('nodePath') });
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.entry, 'remote-info'], { env: { ...process.env, ...runtime.env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`remote-info exited ${code ?? '?'}`))));
  });
  return parseRemoteInfo(stdout.trim().split('\n').pop())?.commit;
}

/** `clikcode update` of the ClikCode this editor runs, its lines reported;
 * its last line is what it says. */
export function runClikcodeUpdate(runtime: { node: string; entry: string; env: Record<string, string> }, report: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.entry, 'update'], { env: { ...process.env, ...runtime.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const said: string[] = [];
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => { if (!line.trim()) return; said.push(line); report(line); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && said.length) { resolve(said.at(-1)!); return; }
      const last = stderr.trim().split('\n').filter(Boolean).pop() ?? said.at(-1) ?? `exit ${code ?? '?'}`;
      reject(new Error(/unknown command 'update'/.test(stderr) ? 'This ClikCode is older than `clikcode update`: update it the way it was installed.' : last.replace(/^error:\s*/i, '')));
    });
  });
}

/** The `open` request a chat sends: the folder only when its machine names one. */
export function openRequest(machine: ChatMachine, mode: 'new' | 'continue' | 'resume', sessionId: string | undefined, features: readonly IdeFeature[]): Omit<Extract<IdeRequest, { type: 'open' }>, 'requestId'> {
  const workspace = machine.workspaceForOpen();
  return { type: 'open', ...(workspace ? { workspace } : {}), mode, ...(sessionId ? { sessionId } : {}), features };
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('clikcode');
}

/** This computer: the editor's own workspace and files. */
export class LocalChatMachine implements ChatMachine {
  readonly kind = 'local' as const;
  readonly id = 'local';
  readonly name = undefined;
  readonly filesHere = true;
  /** Pasted images: a directory of this chat's own (mkdtemp: 0700, a fresh
   * name, so no other user can read it or plant a link in it), emptied as
   * each image's turn ends and removed with the chat. */
  private imageDir: Promise<string> | undefined;

  reachable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async connect(log: (line: string) => void): Promise<MachineConnection> {
    const runtime = await resolveRuntime({ path: settings().get<string>('path'), nodePath: settings().get<string>('nodePath') });
    log(`Starting ${runtime.entry} (${runtime.entrySource}) with ${runtime.node} (${runtime.nodeSource})`);
    return { bridge: bridgePool.connect(runtime, this.workspaceForOpen(), settings().get<boolean>('sharedProcess', true)) };
  }

  workspaceForOpen(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath ?? homedir();
  }

  async conversations(own?: () => Promise<BridgeEndpoint | undefined>): Promise<IdeConversation[]> {
    if (own) return (await (await own())?.call<IdeConversation[]>({ type: 'query', query: 'conversations' })) ?? [];
    // The chat is on another machine: a channel into the window's ClikCode
    // (the process other local chats share, started for this if none) asks.
    const runtime = await resolveRuntime({ path: settings().get<string>('path'), nodePath: settings().get<string>('nodePath') });
    const bridge = bridgePool.connect(runtime, undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Local ClikCode did not start.')), TIMEOUT.start);
        bridge.on('event', (event) => { if (event.type === 'ready') { clearTimeout(timeout); resolve(); } });
        bridge.once('exit', () => { clearTimeout(timeout); reject(new Error('Local ClikCode stopped.')); });
      });
      return await bridge.call<IdeConversation[]>({ type: 'query', query: 'conversations' });
    } finally { bridge.dispose(); }
  }

  searchFiles(text: string): Promise<Mention[]> {
    return searchWorkspaceFiles(text);
  }

  pastedReference(text: string): PastedReference {
    return pastedReference(text);
  }

  mentionsFromUris(uris: readonly string[]): Mention[] {
    return uris.flatMap((text) => {
      try {
        const uri = vscode.Uri.parse(text.trim(), true);
        return uri.scheme === 'file' ? [mentionFromUri(uri)] : [];
      } catch { return []; }
    });
  }

  async stageImage(name: string, bytes: Buffer): Promise<string> {
    this.imageDir ??= mkdtemp(join(tmpdir(), 'clikcode-vscode-images-'));
    const safe = name.replace(/[^\w.-]+/g, '_').slice(-60) || 'image.png';
    const path = join(await this.imageDir, `${Date.now().toString(36)}-${safe}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  }

  async releaseImage(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  runSignIn(event: SignInEvent, bridge: BridgeEndpoint, workspace: string | undefined): Promise<void> {
    return runInTerminal({
      name: `sign in to ${event.name}`,
      node: bridge.runtime.node,
      args: [bridge.runtime.entry, 'ide-terminal', event.spec],
      env: { ...event.environment, ...bridge.runtime.env },
      cwd: workspace ?? this.workspaceForOpen(),
    });
  }

  async openFile(path: string, options: { line?: number; workspace?: string; preview: boolean }): Promise<void> {
    const clean = path.replace(/^file:\/\//, '').replace(/^~(?=\/)/, homedir());
    const uri = /^([a-zA-Z]:[\\/]|\/)/.test(clean) ? vscode.Uri.file(clean) : vscode.Uri.joinPath(vscode.Uri.file(options.workspace ?? this.workspaceForOpen()), clean);
    const document = await vscode.workspace.openTextDocument(uri);
    const position = options.line && options.line > 0 ? new vscode.Position(options.line - 1, 0) : undefined;
    await vscode.window.showTextDocument(document, { preview: options.preview, ...(position ? { selection: new vscode.Range(position, position) } : {}) });
  }

  async update(report: (line: string) => void): Promise<string> {
    const runtime = await resolveRuntime({ path: settings().get<string>('path'), nodePath: settings().get<string>('nodePath') });
    return runClikcodeUpdate(runtime, report);
  }

  dispose(): void {
    void this.imageDir?.then((dir) => rm(dir, { recursive: true, force: true }), () => undefined);
  }
}

/** Another machine, over SSH: its folders and files are its own, and this
 * editor names none of them. File search, pasted file references and
 * dropped URIs would name this editor's files, which that machine does not
 * have -- they offer nothing (until the bridge can search its own folder). */
export class RemoteChatMachine implements ChatMachine {
  readonly kind = 'remote' as const;
  readonly filesHere = false;
  /** Where each staged image went (the target it was uploaded through). */
  private readonly images = new Map<string, string>();

  constructor(private record: RemoteMachine) {}

  get id(): string { return this.record.id; }
  get name(): string { return this.record.name; }

  /** The record as it is now: an install can move it to another login. */
  private async current(): Promise<RemoteMachine> {
    const view = await remoteDirectory.machine(this.record.id);
    if (!view) throw new Error(`${this.record.name} is no longer added.`);
    this.record = view.machine;
    return view.machine;
  }

  async reachable(): Promise<boolean> {
    const view = await remoteDirectory.machine(this.record.id);
    return Boolean(view && view.state !== 'offline');
  }

  async connect(log: (line: string) => void): Promise<MachineConnection> {
    const machine = await this.current();
    log(`Connecting to ${machine.name} over SSH`);
    return { bridge: bridgePool.connectRemote(machine) };
  }

  workspaceForOpen(): undefined {
    return undefined;
  }

  conversations(): Promise<IdeConversation[]> {
    return remoteDirectory.conversations(this.record.id);
  }

  searchFiles(): Promise<Mention[]> {
    return Promise.resolve([]);
  }

  pastedReference(): undefined {
    return undefined;
  }

  mentionsFromUris(): Mention[] {
    return [];
  }

  async stageImage(name: string, bytes: Buffer): Promise<string> {
    const { sshTarget } = await this.current();
    const path = await uploadRemoteImage(sshTarget, name, bytes);
    this.images.set(path, sshTarget);
    return path;
  }

  async releaseImage(path: string): Promise<void> {
    const target = this.images.get(path);
    if (!target) return;
    this.images.delete(path);
    await removeRemoteImage(target, path);
  }

  async runSignIn(event: SignInEvent): Promise<void> {
    const { sshTarget } = await this.current();
    await runInTerminal({
      name: `sign in to ${event.name} on ${sshTarget}`,
      node: 'ssh', args: sshArgv(sshTarget, remoteTerminalScript(event.spec), ['-tt']), env: {},
    });
  }

  /** A file of the chat's names a path on that machine: one of the same name
   * here would be another file. */
  openFile(path: string): Promise<void> {
    return Promise.reject(new Error(`${path} is on ${this.record.name}; open that workspace through VS Code Remote SSH to edit it.`));
  }

  async update(report: (line: string) => void): Promise<string> {
    const outcome = await remoteDirectory.update(this.record.id, {
      start: (step, index, total) => report(`${index}/${total} ${step}`),
      done: (step, detail) => report(`✓ ${step}${detail ? ` · ${detail}` : ''}`),
    });
    if (!outcome.ok) throw new Error(`${outcome.step}: ${outcome.message}`);
    return `ClikCode on ${this.record.name} is updated${outcome.info.commit ? ` to ${outcome.info.commit.slice(0, 8)}` : ''}; its chats switch over once they are quiet.`;
  }

  dispose(): void {
    for (const [path, target] of this.images) void removeRemoteImage(target, path).catch(() => undefined);
    this.images.clear();
  }
}
