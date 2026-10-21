/** The composer's machine chip is one of the chat's settings: choosing another
 * machine moves THIS chat there (export here, import there once, mark moved
 * here) with nothing asked and nothing said; an empty chat simply becomes a
 * new chat there. Typing /machine opens the chip's menu, as /permission opens the mode
 * menu. A moved chat is read-only and offers the moved one. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  bridges: [] as Array<{ machine: string; requests: Array<{ type: string; [key: string]: unknown }> }>,
  next: {} as Record<string, () => unknown>,
  warnings: [] as string[],
  answer: undefined as string | undefined,
  notes: [] as string[],
  /** The machine menu's connection to m1, when it has one open. */
  channel: undefined as undefined | { revision: number; requests: Array<{ type: string; [key: string]: unknown }>; closed: boolean },
  held: 0,
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.clear(); }
  }
  return {
    EventEmitter,
    Disposable: class { constructor(private readonly done: () => void) {} dispose(): void { this.done(); } },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }), workspaceFolders: [] },
    window: {
      showErrorMessage: async (text: string) => { world.notes.push(text); return undefined; },
      showInformationMessage: async (text: string) => { world.notes.push(text); return undefined; },
      showWarningMessage: async (text: string) => { world.warnings.push(text); return world.answer; },
    },
    env: { clipboard: { writeText: async () => undefined } },
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  };
});
vi.mock('../../src/ui', () => ({ DiffDocuments: class {}, openSignInLink: () => undefined, runInTerminal: async () => undefined, fileNameIn: () => undefined }));
vi.mock('../../src/remote-directory', () => ({
  remoteDirectory: {
    machine: async (id: string) => (id === 'm1' ? { machine: { id: 'm1', name: 'prod', sshTarget: 'root@prod', ready: true }, state: 'connected', needsUpdate: false, chats: [] } : undefined),
    localCommit: async () => undefined,
    watch: () => () => undefined,
    hold: () => { world.held += 1; return () => { world.held -= 1; }; },
    channel: async (id: string) => {
      const channel = id === 'm1' ? world.channel : undefined;
      if (!channel) return undefined;
      return {
        revision: channel.revision,
        request: async (request: { type: string }) => {
          channel.requests.push(request);
          if (request.type === 'import-chat') return { sessionId: 's1', folder: '/root', changes: [], installationId: 'prod-install' };
          return undefined;
        },
        close: () => { channel.closed = true; },
      };
    },
  },
  machineUpdateOf: () => undefined,
}));
vi.mock('../../../../src/remote/machines', () => ({
  readMachines: async () => [{ id: 'm1', name: 'prod', sshTarget: 'root@prod', ready: true, installationId: 'prod-install' }],
  forgetMachine: async () => [], newMachineRecord: () => ({}), updateMachine: async () => undefined, updateMachines: async () => [],
}));
vi.mock('../../src/chat-machine', () => {
  const connect = (machine: string) => async () => { const bridge = world.next[machine]!(); return { bridge }; };
  class LocalChatMachine {
    readonly kind = 'local'; readonly id = 'local'; readonly name = undefined; readonly filesHere = true;
    reachable = async () => true;
    workspaceForOpen = () => '/work';
    connect = connect('local');
    releaseImage = async () => undefined;
    dispose = () => undefined;
  }
  class RemoteChatMachine {
    readonly kind = 'remote'; readonly filesHere = false;
    constructor(private readonly record: { id: string; name: string }) {}
    get id(): string { return this.record.id; }
    get name(): string { return this.record.name; }
    reachable = async () => true;
    workspaceForOpen = () => undefined;
    connect = connect('m1');
    releaseImage = async () => undefined;
    dispose = () => undefined;
  }
  return {
    LocalChatMachine, RemoteChatMachine,
    openRequest: (machine: { workspaceForOpen(): string | undefined }, mode: string, sessionId: string | undefined, features: unknown) => {
      const workspace = machine.workspaceForOpen();
      return { type: 'open', ...(workspace ? { workspace } : {}), mode, ...(sessionId ? { sessionId } : {}), features };
    },
  };
});

import { BridgeEndpoint } from '../../src/bridge-client';
import { ClikCodeController } from '../../src/controller';
import { commandMenu } from '../../src/webview/composer';
import type { IdeEvent, IdeRequest } from '../../src/protocol';

const session = (id: string, messages: number, extra: Record<string, unknown> = {}) => ({
  id, route: 'local', accountId: null, provider: 'anthropic', nativeHarness: 'claude', model: 'opus', effort: 'high', name: 'Chat',
  createdAt: '', updatedAt: '', status: 'active', messages: Array.from({ length: messages }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` })), ...extra,
});

/** A machine's ClikCode: opens chats, and answers a move the way the real bridge does. */
class FakeBridge extends BridgeEndpoint {
  readonly requests: Array<{ type: string; [key: string]: unknown }> = [];
  constructor(readonly machine: string, private readonly chat: { messages: number; changes?: string[]; movedTo?: unknown }) {
    super({ node: 'node', entry: '/fake/index.js', env: {}, nodeSource: 'path', entrySource: 'path' }, 'build-1');
    world.bridges.push(this);
    setTimeout(() => this.receive({ type: 'ready', version: 't', protocol: 1, revision: 4, pid: 1 }), 0);
  }
  send(request: IdeRequest): boolean {
    this.requests.push(request as never);
    const answer = (data?: unknown): void => { setTimeout(() => this.receive({ type: 'result', requestId: (request as { requestId: string }).requestId, ok: true, ...(data === undefined ? {} : { data }) } as IdeEvent), 0); };
    if (request.type === 'open') {
      const id = request.sessionId ?? (this.machine === 'local' ? 's1' : 'new-there');
      setTimeout(() => this.receive({ type: 'session', session: session(id, this.chat.messages, this.chat.movedTo ? { movedTo: this.chat.movedTo } : {}) as never }), 0);
      answer({ sessionId: id });
    } else if (request.type === 'export-chat') answer({ version: 1, sessionId: 's1', conversationId: 's1', createdAt: '', messages: [], settings: {}, source: {} });
    else if (request.type === 'import-chat') answer({ sessionId: 's1', folder: '/root', changes: this.chat.changes ?? [], installationId: 'prod-install' });
    else if ('requestId' in request) answer();
    return true;
  }
  dispose(): void { this.markExited(0, null); }
  logDrained(): Promise<void> { return Promise.resolve(); }
}

const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const controllers: ClikCodeController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); world.bridges = []; world.warnings = []; world.answer = undefined; world.notes = []; world.channel = undefined; world.held = 0; });

const startChat = async (local: { messages: number; movedTo?: unknown }, remote: { messages: number; changes?: string[] } = { messages: 2 }) => {
  world.next = { local: () => new FakeBridge('local', local), m1: () => new FakeBridge('m1', remote) };
  const host = { log: { appendLine: () => undefined }, diffs: {}, openInTab: async () => undefined, reveal: async () => undefined, chats: () => [] };
  const controller = new ClikCodeController(host as never, undefined, 'chat');
  controllers.push(controller);
  await controller.ensureStarted();
  await until(() => controller.state.connection === 'ready' && controller.state.sessionId === 's1');
  return controller;
};
const requestsOf = (machine: string) => world.bridges.filter((bridge) => bridge.machine === machine).flatMap((bridge) => bridge.requests.map((request) => request.type === 'import-chat' ? `import-chat${'dryRun' in request ? ' (dry run)' : ''}` : request.type));
/** What the chat shows besides its conversation: a note, a toast, a dialog. */
const said = (controller: ClikCodeController): string[] => [...world.warnings, ...world.notes, ...((controller.state as { notes?: Array<{ text: string }> }).notes ?? []).map((note) => note.text)];

type ChatModelLike = { messages: unknown[]; sessionId?: string; machine?: string };

describe('the machine chip', () => {
  it('moves this chat to the machine chosen, and shows it there: one import, nothing asked or said', async () => {
    const controller = await startChat({ messages: 2 });
    await controller.moveToMachine('m1');
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    expect(requestsOf('local')).toEqual(expect.arrayContaining(['open', 'export-chat', 'mark-moved']));
    expect(requestsOf('m1').filter((type) => type !== 'visible')).toEqual(['import-chat', 'open']);
    const mark = world.bridges.flatMap((bridge) => bridge.requests).find((request) => request.type === 'mark-moved');
    expect(mark).toMatchObject({ sessionId: 's1', movedTo: { machine: 'prod', sessionId: 's1', installationId: 'prod-install' } });
    // The chat there is resumed, with no folder of this computer's.
    const open = world.bridges.filter((bridge) => bridge.machine === 'm1').flatMap((bridge) => bridge.requests).find((request) => request.type === 'open');
    expect(open).toEqual(expect.objectContaining({ mode: 'resume', sessionId: 's1' }));
    expect(open).not.toHaveProperty('workspace');
    expect(controller.state.sessionId).toBe('s1');
    expect(said(controller)).toEqual([]);
  });

  it('keeps the chat on screen the whole time it moves, as an account switch does', async () => {
    const controller = await startChat({ messages: 2 });
    const shown: Array<{ messages: number; sessionId?: string; machine?: string }> = [];
    const internal = controller as unknown as { setModel(model: ChatModelLike): void };
    const setModel = internal.setModel.bind(controller);
    internal.setModel = (model) => { shown.push({ messages: model.messages.length, sessionId: model.sessionId, machine: model.machine }); setModel(model); };
    await controller.moveToMachine('m1');
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    // Never an empty panel: the conversation stays, and the machine is the one thing that changes.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((model) => model.messages === 0 || !model.sessionId)).toEqual([]);
    expect(shown.find((model) => model.machine === 'prod')).toBeDefined();
  });

  it('moves even when something changes there, without a dialog or a notice', async () => {
    const controller = await startChat({ messages: 2 }, { messages: 2, changes: ['Bypass → Auto (root).'] });
    await controller.moveToMachine('m1');
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    expect(world.warnings).toEqual([]);
    expect(requestsOf('m1').filter((type) => type === 'import-chat')).toEqual(['import-chat']);
    expect(requestsOf('local')).toContain('mark-moved');
    expect(said(controller)).toEqual([]);
  });

  it('moves over the connection the machine menu already has, and keeps it open meanwhile', async () => {
    world.channel = { revision: 4, requests: [], closed: false };
    const controller = await startChat({ messages: 2 });
    const moving = controller.moveToMachine('m1');
    expect(world.held).toBe(1);
    await moving;
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    expect(world.channel.requests.map((request) => request.type)).toEqual(['import-chat']);
    expect(world.channel.closed).toBe(true);
    expect(world.held).toBe(0);
    // The chat's own connection there only opens it.
    expect(requestsOf('m1').filter((type) => type !== 'visible')).toEqual(['open']);
    expect(said(controller)).toEqual([]);
  });

  it('on an empty chat, nothing moves: it is a new chat on that machine', async () => {
    const controller = await startChat({ messages: 0 }, { messages: 0 });
    await controller.moveToMachine('m1');
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    expect(requestsOf('local')).not.toContain('export-chat');
    // One connection there, which opens the new chat.
    expect(world.bridges.filter((bridge) => bridge.machine === 'm1')).toHaveLength(1);
    expect(requestsOf('m1').filter((type) => type !== 'visible')).toEqual(['open']);
    const open = world.bridges.find((bridge) => bridge.machine === 'm1')!.requests.find((request) => request.type === 'open');
    expect(open).toMatchObject({ type: 'open', mode: 'new' });
    expect(controller.state.sessionId).toBe('new-there');
  });

  it('a moved chat is read-only and opens the moved one on its machine', async () => {
    const controller = await startChat({ messages: 2, movedTo: { machine: 'prod', installationId: 'prod-install', sessionId: 'there-1', at: '' } });
    expect(controller.state.movedTo).toMatchObject({ machine: 'prod', sessionId: 'there-1' });
    await controller.openMoved();
    await until(() => controller.state.connection === 'ready' && controller.state.machine === 'prod');
    expect(world.bridges.find((bridge) => bridge.machine === 'm1')!.requests.find((request) => request.type === 'open')).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'there-1' });
  });
});

describe('typing a setting the composer has a menu for', () => {
  it('opens the machine chip’s menu for /machine, as /permission opens the mode menu', () => {
    expect(commandMenu('/machine')).toBe('machines');
    expect(commandMenu(' /Machine ')).toBe('machines');
    expect(commandMenu('/permission')).toBe('mode');
    expect(commandMenu('/permissions')).toBe('mode');
    expect(commandMenu('/machines are cool')).toBeUndefined();
    expect(commandMenu('/model')).toBeUndefined();
  });
});
