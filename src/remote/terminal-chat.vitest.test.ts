import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { remoteResume, runRemoteChat } from './terminal-chat.js';
import { newMachineRecord, updateMachines } from './machines.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';

describe('remote chat open request', () => {
  it('resumes by id and names no folder of this machine', () => {
    const request = remoteResume('chat-1');
    expect(request).toEqual({ type: 'open', mode: 'resume', sessionId: 'chat-1' });
    expect('workspace' in request).toBe(false);
    expect(JSON.stringify(request)).not.toContain(process.cwd());
  });
});

/** The other machine's `ide-bridge --stdio`, in memory: a chat's ready, an
 * open answered with the chat, a send answered as done -- and told to leave
 * for a newer build (host-retiring, then the close) or to drop. */
class FakeRemoteBridge extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<{ type: string; mode?: string; sessionId?: string; text?: string }> = [];
  private chat = '';
  constructor() {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'chat-attach') { this.chat = message.chat; this.say({ type: 'ready', version: 't', pid: 1 }); return; }
      const request = message.request;
      this.requests.push(request);
      if (request.type === 'open') {
        this.say({ type: 'session', session: { id: request.sessionId, route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] } });
        this.say({ type: 'result', requestId: request.requestId, ok: true, data: { sessionId: request.sessionId } });
      }
      if (request.type === 'send') this.say({ type: 'send-complete', id: request.id });
    });
    setImmediate(() => this.write({ type: 'host-ready', version: 't', protocol: 1, revision: 3, pid: 1 }));
  }
  private write(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  private say(event: unknown): void { this.write({ type: 'chat', chat: this.chat, event }); }
  /** Leaves for a newer build, as bridge-mux.ts does. */
  retire(): void { this.write({ type: 'host-retiring', reason: 'newer-build' }); this.write({ type: 'chat-closed', chat: this.chat }); this.drop(); }
  drop(): void { this.stdout.end(); setTimeout(() => this.emit('close', 0, null), 20); }
  kill(): boolean { this.drop(); return true; }
}

/** A terminal whose prompt is answered by the test; everything else is noted. */
const fakeTerminal = () => {
  const said: string[] = [];
  const prompts: Array<{ answer: (line: string) => void }> = [];
  const terminal = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'question') {
        return (_prompt: string, _items: unknown, options: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
          const interrupted = () => reject(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
          if (options.signal?.aborted) { interrupted(); return; }
          options.signal?.addEventListener('abort', interrupted, { once: true });
          prompts.push({ answer: resolve });
        });
      }
      if (key === 'activity') return (line: string) => said.push(line);
      if (key === 'then') return undefined;
      return () => undefined;
    },
    set: () => true,
  }) as unknown as TerminalHarnessPrompter;
  return { terminal, said, prompts };
};

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('a chat on another machine whose bridge leaves for a newer build', () => {
  it('connects again and resumes the same chat with nothing said; a real drop is still said', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const { terminal, said, prompts } = fakeTerminal();
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    });
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => prompts.length === 1);
    expect(bridges[0]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c1' });
    bridges[0]!.retire();
    await until(() => prompts.length === 2);
    expect(bridges).toHaveLength(2);
    expect(bridges[1]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c1' });
    expect(said).toEqual([]);
    // It keeps working on the new bridge.
    prompts[1]!.answer('hello again');
    await until(() => bridges[1]!.requests.some((request) => request.type === 'send'));
    expect(bridges[1]!.requests.find((request) => request.type === 'send')).toMatchObject({ text: 'hello again' });
    await until(() => prompts.length === 3);
    // A connection that is lost, not retired: ends the chat as before, with no reconnect.
    bridges[1]!.drop();
    expect(await outcome).toBe('interrupted');
    expect(bridges).toHaveLength(2);
  }, 20_000);
});
