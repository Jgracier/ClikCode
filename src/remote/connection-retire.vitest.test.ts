/** The board's connection to a machine whose bridge leaves for a newer build
 * (ide/bridge-retire.ts): made again at once, with no backoff, and never
 * shown as offline. A connection that just drops still is. */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { RemoteLink } from './connection.js';
import { newMachineRecord } from './machines.js';

class FakeBoardBridge extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  constructor(chats: unknown[]) {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'chat-attach') this.write({ type: 'chat', chat: message.chat, event: { type: 'ready', version: 't', pid: 1 } });
      if (message.type === 'chat' && message.request.type === 'query') this.write({ type: 'chat', chat: message.chat, event: { type: 'result', requestId: message.request.requestId, ok: true, data: chats } });
    });
    setImmediate(() => this.write({ type: 'host-ready', version: 't', protocol: 1, revision: 3, pid: 1 }));
  }
  private write(message: unknown): void { if (!this.stdout.writableEnded) this.stdout.write(`${JSON.stringify(message)}\n`); }
  retire(): void { this.write({ type: 'host-retiring', reason: 'newer-build' }); this.drop(); }
  drop(): void { this.stdout.end(); this.exitCode = 0; setTimeout(() => this.emit('close', 0, null), 10); }
  kill(): boolean { this.drop(); return true; }
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('the board when a machine\'s bridge leaves for a newer build', () => {
  it('connects again at once and stays connected; a drop is offline and waits its backoff', async () => {
    const chat = { id: 'c1', title: 'Fix it', updatedAt: '', messages: 1, section: 'active', current: false };
    const bridges: FakeBoardBridge[] = [];
    const states: string[] = [];
    let link!: RemoteLink;
    link = new RemoteLink(newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true }), () => states.push(link.view.state), {
      spawn: () => { const bridge = new FakeBoardBridge([chat]); bridges.push(bridge); return bridge as unknown as ChildProcess; },
      backoffMs: [60_000], autoUpdate: false, localCommit: undefined,
    });
    link.start();
    try {
      await until(() => link.view.state === 'connected' && link.view.chats.length === 1);
      states.length = 0;
      bridges[0]!.retire();
      await until(() => bridges.length === 2);
      await until(() => states.length > 0 && link.view.chats.length === 1);
      expect(states).not.toContain('offline');
      expect(states).not.toContain('connecting');
      expect(link.view.state).toBe('connected');
      bridges[1]!.drop();
      await until(() => link.view.state === 'offline');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bridges).toHaveLength(2);
    } finally { await link.stop(); }
  });
});
