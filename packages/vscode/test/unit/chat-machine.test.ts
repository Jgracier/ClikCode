/** A chat on another machine is sent intent, never this computer's facts:
 * no folder of this editor's for a new chat or a resumed one, no local file
 * opened for a path it names, its images and sign-ins on that machine. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChatMachine, RemoteChatMachine, openRequest } from '../../src/chat-machine';

const LOCAL_FOLDER = '/home/editor-user/project';

const calls = vi.hoisted(() => ({
  terminal: [] as Array<{ name: string; node: string; args: string[]; cwd?: string }>,
  uploads: [] as Array<{ target: string; name: string }>,
  removed: [] as Array<{ target: string; path: string }>,
  opened: [] as string[],
}));

vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    showTextDocument: async (document: { uri: { fsPath: string } }) => { calls.opened.push(document.uri.fsPath); },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/home/editor-user/project' } }],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    openTextDocument: async (uri: { fsPath: string }) => ({ uri }),
  },
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ scheme: 'file', fsPath: [base.fsPath, ...parts].join('/') }),
    parse: (text: string) => ({ scheme: text.split(':')[0], fsPath: text.replace(/^file:\/\//, '') }),
  },
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
}));

vi.mock('../../src/ui', () => ({
  runInTerminal: async (options: { name: string; node: string; args: string[]; cwd?: string }) => { calls.terminal.push(options); },
}));

vi.mock('../../src/mentions', () => ({
  searchWorkspaceFiles: async () => [{ label: 'local.ts', path: '/home/editor-user/project/local.ts' }],
  pastedReference: () => ({ files: [{ label: 'local.ts', path: '/home/editor-user/project/local.ts' }] }),
  mentionFromUri: (uri: { fsPath: string }) => ({ label: uri.fsPath, path: uri.fsPath }),
}));

vi.mock('../../../../src/remote/image', () => ({
  uploadRemoteImage: async (target: string, name: string) => { calls.uploads.push({ target, name }); return '/tmp/clikcode-image.abc/image.png'; },
  removeRemoteImage: async (target: string, path: string) => { calls.removed.push({ target, path }); },
}));

const record = { id: 'm1', name: 'prod', sshTarget: 'root@prod', os: 'linux', ready: true };
vi.mock('../../src/remote-directory', () => ({
  remoteDirectory: {
    machine: async (id: string) => (id === 'm1' ? { machine: record, state: 'online', chats: [] } : undefined),
    conversations: async () => [{ id: 'chat-1', workspace: '/root/app', updatedAt: '2026-10-21T00:00:00Z' }],
  },
}));


const signIn = { type: 'sign-in' as const, id: 's1', name: 'Claude', spec: 'claude-login', environment: {} };
const bridge = { runtime: { node: '/usr/bin/node', entry: '/opt/clikcode/cli.js', env: {} } } as never;

beforeEach(() => {
  calls.terminal.length = 0;
  calls.uploads.length = 0;
  calls.removed.length = 0;
  calls.opened.length = 0;
});

describe('RemoteChatMachine', () => {
  const machine = () => new RemoteChatMachine(record as never);

  it('opens a new chat with no folder of this computer', () => {
    const request = openRequest(machine(), 'new', undefined, ['copy']);
    expect(request).toEqual({ type: 'open', mode: 'new', features: ['copy'] });
    expect('workspace' in request).toBe(false);
  });

  it('resumes a chat with no workspace: its own saved one stands', () => {
    const request = openRequest(machine(), 'resume', 'chat-1', []);
    expect(request).toEqual({ type: 'open', mode: 'resume', sessionId: 'chat-1', features: [] });
    expect(JSON.stringify(request)).not.toContain('/home/editor-user');
  });

  it('offers none of this editor’s files for search, paste or drops', async () => {
    const remote = machine();
    expect(remote.workspaceForOpen()).toBeUndefined();
    expect(remote.filesHere).toBe(false);
    expect(await remote.searchFiles()).toEqual([]);
    expect(remote.pastedReference()).toBeUndefined();
    expect(remote.mentionsFromUris()).toEqual([]);
  });

  it('never opens a local file of the same path', async () => {
    await expect(machine().openFile('/root/app/index.ts')).rejects.toThrow(/is on prod/);
    expect(calls.opened).toEqual([]);
  });

  it('puts images on that machine and removes them there', async () => {
    const remote = machine();
    const path = await remote.stageImage('shot.png', Buffer.from('x'));
    expect(calls.uploads).toEqual([{ target: 'root@prod', name: 'shot.png' }]);
    await remote.releaseImage(path);
    expect(calls.removed).toEqual([{ target: 'root@prod', path }]);
  });

  it('runs a vendor sign-in over SSH, in no local folder', async () => {
    await machine().runSignIn(signIn);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.terminal[0]!.node).toBe('ssh');
    expect(calls.terminal[0]!.args).toContain('root@prod');
    expect(calls.terminal[0]!.cwd).toBeUndefined();
  });

  it('lists the machine’s own conversations', async () => {
    expect((await machine().conversations()).map((chat) => chat.id)).toEqual(['chat-1']);
  });
});

describe('LocalChatMachine', () => {
  it('opens in the editor’s workspace folder, as before', () => {
    const local = new LocalChatMachine();
    expect(openRequest(local, 'new', undefined, [])).toEqual({ type: 'open', workspace: LOCAL_FOLDER, mode: 'new', features: [] });
    expect(local.filesHere).toBe(true);
  });

  it('searches and pastes this editor’s files', async () => {
    const local = new LocalChatMachine();
    expect(await local.searchFiles('loc')).toHaveLength(1);
    expect(local.pastedReference('file:///x')?.files).toHaveLength(1);
    expect(local.mentionsFromUris(['file:///home/editor-user/project/a.ts', 'untitled:1'])).toEqual([{ label: '/home/editor-user/project/a.ts', path: '/home/editor-user/project/a.ts' }]);
  });

  it('opens a relative path in the chat’s workspace', async () => {
    await new LocalChatMachine().openFile('src/a.ts', { workspace: '/w', preview: true });
    expect(calls.opened).toEqual(['/w/src/a.ts']);
  });

  it('runs a sign-in with this computer’s ClikCode in the chat’s folder', async () => {
    await new LocalChatMachine().runSignIn(signIn, bridge, '/w');
    expect(calls.terminal[0]).toMatchObject({ node: '/usr/bin/node', args: ['/opt/clikcode/cli.js', 'ide-terminal', 'claude-login'], cwd: '/w' });
  });

  it('asks its own connection for conversations when it is the chat’s machine', async () => {
    const call = vi.fn(async () => [{ id: 'local-1' }]);
    const chats = await new LocalChatMachine().conversations(async () => ({ call }) as never);
    expect(chats).toEqual([{ id: 'local-1' }]);
    expect(call).toHaveBeenCalledWith({ type: 'query', query: 'conversations' });
  });
});
