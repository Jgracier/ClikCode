/** A chat on the window's connection to a machine (RemoteLink.tap): opened with a message on the connection that is up, not an ssh
 * and a process started there; its events come to it alone; it can leave without ending the connection; and a connection that
 * ends or retires ends it. */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { IdeEvent } from '../ide/protocol.js';
import { RemoteLink } from './connection.js';
import { newMachineRecord } from './machines.js';
import { TerminalBridge } from './terminal-chat.js';

class FakeHost extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly seen: Array<{ type: string; chat?: string; request?: { type: string; requestId?: string } }> = [];
  constructor() {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      this.seen.push(message);
      if (message.type === 'chat-attach') this.write({ type: 'chat', chat: message.chat, event: { type: 'ready', version: 't', pid: 1 } });
      if (message.type === 'chat' && message.request.type === 'ping') this.write({ type: 'chat', chat: message.chat, event: { type: 'result', requestId: message.request.requestId, ok: true, data: `pong ${message.chat.slice(0, 4)}` } });
    });
    setImmediate(() => this.write({ type: 'host-ready', version: 't', protocol: 1, revision: 9, pid: 1 }));
  }
  write(message: unknown): void { if (!this.stdout.writableEnded) this.stdout.write(`${JSON.stringify(message)}\n`); }
  retire(): void { this.write({ type: 'host-retiring', reason: 'newer-build' }); this.drop(); }
  drop(): void { this.stdout.end(); setTimeout(() => this.emit('close', 0, null), 10); }
  kill(): boolean { this.drop(); return true; }
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const connected = async () => {
  const hosts: FakeHost[] = [];
  const link = new RemoteLink(newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true }), () => undefined, {
    spawn: () => { const host = new FakeHost(); hosts.push(host); return host as unknown as ChildProcess; },
    backoffMs: [60_000], autoUpdate: false, localCommit: undefined,
  });
  link.start();
  await until(() => link.view.state === 'connected');
  const open = (handlers?: { onClose?: (error: Error) => void }) => {
    const bridge = new TerminalBridge('devbox', () => { throw new Error('a process of its own was started'); }, undefined, (chat, tapHandlers) => link.tap(chat, tapHandlers));
    if (handlers?.onClose) bridge.onClose = handlers.onClose;
    return bridge;
  };
  return { link, hosts, open };
};

describe('a chat on the connection to a machine', () => {
  it('opens without a connection of its own, hears only its own events, and leaves without ending the connection', async () => {
    const { link, hosts, open } = await connected();
    try {
      const first = open();
      const second = open();
      await Promise.all([first.connected(), second.connected()]);
      expect(hosts).toHaveLength(1);
      expect(first.revision).toBe(9);
      const answers = await Promise.all([first.request<string>({ type: 'ping' } as never), second.request<string>({ type: 'ping' } as never)]);
      expect(answers[0]).not.toBe(answers[1]);
      first.close();
      // The host was told, the connection stays, and the other chat still answers.
      await until(() => hosts[0]!.seen.some((message) => message.request?.type === 'close'));
      expect(link.view.state).toBe('connected');
      expect(await second.request<string>({ type: 'ping' } as never)).toMatch(/^pong /);
      expect(() => first.post({ type: 'ping' } as never)).toThrow();
    } finally { await link.stop(); }
  });

  it('ends with the connection: a drop is a drop, a retire says it is leaving for a newer build', async () => {
    const { link, hosts, open } = await connected();
    try {
      const events: IdeEvent[] = [];
      const bridge = open({ onClose: () => undefined });
      bridge.onEvent = (event) => events.push(event);
      await bridge.connected();
      hosts[0]!.retire();
      await until(() => bridge.dropped !== undefined);
      expect(bridge.retiring).toBe(true);
      expect(bridge.wasReady).toBe(true);
      // The connection was made again at once.
      await until(() => hosts.length === 2 && link.view.state === 'connected');
      const next = open();
      await next.connected();
      hosts[1]!.drop();
      await until(() => next.dropped !== undefined);
      expect(next.retiring).toBe(false);
      expect(next.dropped!.message).toContain('ended');
    } finally { await link.stop(); }
  });

  it('is not given when the machine is not connected', async () => {
    const link = new RemoteLink(newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true }), () => undefined, { spawn: () => new FakeHost() as unknown as ChildProcess, autoUpdate: false });
    expect(link.tap('c', { event: () => undefined, ended: () => undefined })).toBeUndefined();
  });

  it('ends with the reason ssh gave, for a chat on the connection as for one of its own', async () => {
    const { link, hosts, open } = await connected();
    try {
      const bridge = open({ onClose: () => undefined });
      await bridge.connected();
      hosts[0]!.stderr.write('client_loop: send disconnect: Broken pipe\n');
      hosts[0]!.drop();
      await until(() => bridge.dropped !== undefined);
      expect(bridge.dropped!.message).toContain('Broken pipe');
    } finally { await link.stop(); }
  });

  it('on a connection of its own, opens its chat and nothing else there, and ends the connection with it', async () => {
    const hosts: FakeHost[] = [];
    const bridge = new TerminalBridge('devbox', () => { const host = new FakeHost(); hosts.push(host); return host as never; });
    await bridge.connected();
    expect(bridge.revision).toBe(9);
    expect(hosts[0]!.seen.map((message) => message.type)).toEqual(['chat-attach']);
    bridge.close();
    await until(() => hosts[0]!.seen.at(-1)?.request?.type === 'close');
  });
});
