/** VS Code's chat with the `session-delta` feature (src/ide/session-delta.ts). */
import { afterEach, describe, expect, it, vi } from 'vitest';

const machine = vi.hoisted(() => ({ connects: [] as unknown[], next: undefined as undefined | (() => unknown) }));

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
    window: { showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
    env: { clipboard: { writeText: async () => undefined } },
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  };
});
vi.mock('../../src/ui', () => ({ DiffDocuments: class {}, openSignInLink: () => undefined, runInTerminal: async () => undefined, fileNameIn: () => undefined }));
vi.mock('../../src/chat-machine', () => {
  class LocalChatMachine {
    readonly kind = 'local';
    readonly id = 'local';
    readonly name = undefined;
    readonly filesHere = true;
    reachable = async () => true;
    workspaceForOpen = () => '/work';
    connect = async () => { const bridge = machine.next!(); machine.connects.push(bridge); return { bridge }; };
    releaseImage = async () => undefined;
    dispose = () => undefined;
  }
  return {
    LocalChatMachine, RemoteChatMachine: class {},
    openRequest: (_machine: unknown, mode: string, sessionId: string | undefined, features: unknown) => ({ type: 'open', mode, ...(sessionId ? { sessionId } : {}), features }),
  };
});

import { BridgeEndpoint } from '../../src/bridge-client';
import { ClikCodeController } from '../../src/controller';
import type { IdeEvent, IdeRequest } from '../../src/protocol';

/** A bridge that answers an `open` with the chat, and is told to leave or crash. */
class FakeBridge extends BridgeEndpoint {
  readonly requests: IdeRequest[] = [];
  constructor() {
    super({ node: 'node', entry: '/fake/index.js', env: {}, nodeSource: 'path', entrySource: 'path' }, 'build-1');
    setTimeout(() => this.receive({ type: 'ready', version: 't', protocol: 1, revision: 3, pid: 1 }), 0);
  }
  send(request: IdeRequest): boolean {
    this.requests.push(request);
    if (request.type === 'open') {
      setTimeout(() => {
        this.receive({ type: 'session', session: { id: 's1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Chat', createdAt: '', updatedAt: '', status: 'active', messages: [{ role: 'user', content: 'hi' }] } as never });
        this.receive({ type: 'result', requestId: request.requestId, ok: true, data: { sessionId: 's1' } });
      }, 0);
    } else if ('requestId' in request) {
      setTimeout(() => this.receive({ type: 'result', requestId: request.requestId, ok: false, error: 'not here' }), 0);
    }
    return true;
  }
  dispose(): void { this.markExited(0, null); }
  logDrained(): Promise<void> { return Promise.resolve(); }
  say(event: IdeEvent): void { this.receive(event); }
  exit(code: number | null): void { this.markExited(code, null); }
}

const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const controllers: Array<{ dispose(): void }> = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); machine.connects = []; });

const startChat = async () => {
  machine.next = () => new FakeBridge();
  const log: string[] = [];
  const host = { log: { appendLine: (line: string) => log.push(line) }, diffs: {}, openInTab: async () => undefined, reveal: async () => undefined, chats: () => [] };
  const controller = new ClikCodeController(host as never, undefined, 'chat');
  controllers.push(controller);
  await controller.ensureStarted();
  await until(() => controller.state.connection === 'ready' && controller.state.sessionId === 's1');
  return { controller, log, bridges: machine.connects as FakeBridge[] };
};

describe('a chat sent only what it lacks (session-delta)', () => {
  const base = { id: 's1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Chat', createdAt: '', updatedAt: '', status: 'active' };
  it('asks for it on open, and shows the whole conversation from the tails', async () => {
    const { controller, bridges } = await startChat();
    expect(bridges[0]!.requests.find((request) => request.type === 'open')).toMatchObject({ features: expect.arrayContaining(['session-delta']) });
    expect(controller.state.messages.map((message) => message.content)).toEqual(['hi']);
    // A turn's end: the worker's snapshot with its two messages, then the session with none new.
    bridges[0]!.say({ type: 'worker', sessionId: 's1', messagesFrom: 1, event: { type: 'snapshot', session: { ...base, messages: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'and?' }] } as never } });
    bridges[0]!.say({ type: 'session', messagesFrom: 3, session: { ...base, name: 'Renamed', messages: [] } as never });
    expect(controller.state.messages.map((message) => message.content)).toEqual(['hi', 'hello', 'and?']);
    expect(controller.state.title).toBe('Renamed');
    // Whole again (a rewrite): replaces what it held.
    bridges[0]!.say({ type: 'session', session: { ...base, messages: [{ role: 'user', content: 'only' }] } as never });
    bridges[0]!.say({ type: 'session', messagesFrom: 1, session: { ...base, messages: [{ role: 'assistant', content: 'this' }] } as never });
    expect(controller.state.messages.map((message) => message.content)).toEqual(['only', 'this']);
  });
});
