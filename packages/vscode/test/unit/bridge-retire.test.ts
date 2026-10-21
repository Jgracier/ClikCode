/** A bridge that leaves for a newer ClikCode build (src/ide/bridge-retire.ts)
 * is reconnected at once and the same chat re-opened on the new one, with no
 * banner or note -- and, in the window's shared process, every chat in it
 * hears why before the exit. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { BridgePool } from '../../src/bridge-pool';
import type { IdeEvent, IdeRequest } from '../../src/protocol';
import type { Runtime } from '../../src/runtime';

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

describe('the chat when its bridge leaves for a newer build', () => {
  it('reconnects at once and re-opens the same chat, with no banner or note', async () => {
    const { controller, bridges, log } = await startChat();
    const notesBefore = controller.state.notes?.length ?? 0;
    bridges[0]!.say({ type: 'retiring', reason: 'newer-build' });
    bridges[0]!.exit(0);
    await until(() => bridges.length === 2 && controller.state.connection === 'ready' && bridges[1]!.requests.some((request) => request.type === 'open'));
    const open = bridges[1]!.requests.find((request) => request.type === 'open');
    expect(open).toMatchObject({ type: 'open', mode: 'resume', sessionId: 's1' });
    expect(controller.state.connectionError).toBeUndefined();
    expect(controller.state.notes?.length ?? 0).toBe(notesBefore);
    expect(controller.state.sessionId).toBe('s1');
    expect(log.join('\n')).toMatch(/reconnecting on the new build/);
  });

  it('does not spend the once-a-minute reconnect a crash gets', async () => {
    const { controller, bridges } = await startChat();
    bridges[0]!.say({ type: 'retiring', reason: 'newer-build' });
    bridges[0]!.exit(0);
    await until(() => bridges.length === 2 && controller.state.connection === 'ready');
    // A real crash after it: still reconnected on its own.
    bridges[1]!.exit(1);
    await until(() => bridges.length === 3 && controller.state.connection === 'ready');
    // A second crash within the minute is the banner, as before.
    bridges[2]!.exit(1);
    await until(() => controller.state.connection === 'stopped');
    expect(controller.state.connectionError).toMatch(/stopped unexpectedly/);
  });
});

/** The pool's shared process, leaving: `host-retiring`, every chat closed, exit. */
const FAKE = `
if (process.argv[2] !== 'ide-bridge') process.exit(2);
const chats = new Set();
process.send({ type: 'host-ready', version: 't', protocol: 1, revision: 3, pid: process.pid });
process.on('message', (m) => {
  if (m.type === 'chat-attach') { chats.add(m.chat); process.send({ type: 'chat', chat: m.chat, event: { type: 'ready', version: 't', protocol: 1, revision: 3, pid: process.pid } }); }
  if (m.type === 'chat' && m.request.type === 'query' && m.request.query === 'retire') {
    process.send({ type: 'host-retiring', reason: 'newer-build' });
    for (const chat of chats) process.send({ type: 'chat-closed', chat });
    process.send({ type: 'flush' }, () => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));
`;

describe('the window\'s shared process leaving for a newer build', () => {
  it('tells each of its chats before the exit, and the next connection is a new process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clikcode-fake-retire-'));
    const entry = join(dir, 'index.js');
    writeFileSync(entry, FAKE);
    const runtime: Runtime = { node: process.execPath, env: {}, entry, nodeSource: 'path', entrySource: 'path' };
    const pool = new BridgePool();
    const a = pool.connect(runtime, dir);
    const b = pool.connect(runtime, dir);
    const seen = (bridge: typeof a) => {
      const order: string[] = [];
      bridge.on('event', (event) => order.push(event.type));
      bridge.on('exit', () => order.push('exit'));
      return order;
    };
    const [orderA, orderB] = [seen(a), seen(b)];
    await until(() => orderA.includes('ready') && orderB.includes('ready'), 10_000);
    a.send({ type: 'query', requestId: 'r', query: 'retire' as never });
    await until(() => orderA.includes('exit') && orderB.includes('exit'), 10_000);
    for (const order of [orderA, orderB]) expect(order.slice(-2)).toEqual(['retiring', 'exit']);
    expect(pool.sharedProcesses).toBe(0);
    const c = pool.connect(runtime, dir);
    const orderC = seen(c);
    await until(() => orderC.includes('ready'), 10_000);
    expect(pool.sharedProcesses).toBe(1);
    c.dispose();
  }, 30_000);
});
