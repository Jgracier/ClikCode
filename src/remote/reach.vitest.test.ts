/** Whether a chat can be opened on a machine is the window's connection's to say (RemoteMachines.reach): one place that knows, with
 * one retry schedule -- not an ssh started at a machine that may be down, found out after its timeout, and another chat shown. */
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { closeWindowMachines, holdWindowMachines, RemoteMachines } from './connection.js';
import { newMachineRecord, updateMachines } from './machines.js';
import { RemoteUnavailable, runRemoteChat } from './terminal-chat.js';

/** A machine that answers (`up`), says nothing (`silent`), or refuses at once (`down`). */
class FakeHost extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(kind: 'up' | 'silent' | 'down') {
    super();
    if (kind === 'up') {
      createInterface({ input: this.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.type === 'chat-attach') this.write({ type: 'chat', chat: message.chat, event: { type: 'ready', version: 't', pid: 1 } });
      });
      setImmediate(() => this.write({ type: 'host-ready', version: 't', protocol: 1, revision: 9, pid: 1 }));
    }
    if (kind === 'down') setImmediate(() => { this.stderr.write('ssh: connect to host devbox port 22: Connection refused\n'); this.stdout.end(); setTimeout(() => this.emit('close', 255, null), 5); });
  }
  private write(message: unknown): void { if (!this.stdout.writableEnded) this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean { this.stdout.end(); setTimeout(() => this.emit('close', 0, null), 5); return true; }
}

const withHosts = (kind: 'up' | 'silent' | 'down') => {
  const hosts: FakeHost[] = [];
  return { hosts, options: { spawn: () => { const host = new FakeHost(kind); hosts.push(host); return host as unknown as ChildProcess; }, backoffMs: [60_000], autoUpdate: false, localCommit: undefined } };
};

afterEach(async () => { await closeWindowMachines(); });

describe('reaching a machine to open a chat on it', () => {
  it('is yes at once for a connected machine', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { hosts, options } = withHosts('up');
    const machines = new RemoteMachines(options, true);
    try {
      const held = await machines.hold();
      expect(await machines.reach(machine.id, 2_000)).toEqual({ ok: true });
      expect(hosts).toHaveLength(1);
      held.release();
    } finally { await machines.close(); }
  });

  it('waits for a machine that is connecting, then says it did not answer', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { options } = withHosts('silent');
    const machines = new RemoteMachines(options, true);
    try {
      await machines.hold();
      const began = Date.now();
      const reached = await machines.reach(machine.id, 400);
      expect(reached.ok).toBe(false);
      expect(Date.now() - began).toBeGreaterThanOrEqual(350);
      expect((reached as { reason: string }).reason).toMatch(/no answer/);
    } finally { await machines.close(); }
  });

  it('tries a machine that is down now, not after its pause, and says why it is down', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { hosts, options } = withHosts('down');
    const machines = new RemoteMachines(options, true);
    try {
      const held = await machines.hold();
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = hosts.length;
      const reached = await machines.reach(machine.id, 2_000);
      expect(reached.ok).toBe(false);
      expect((reached as { reason: string }).reason).toContain('Connection refused');
      // Its backoff is a minute; the attempt was made now.
      expect(hosts.length).toBeGreaterThan(before);
    } finally { await machines.close(); }
  });

  it('is no for a machine that is not added', async () => {
    const machines = new RemoteMachines(withHosts('up').options, true);
    try {
      await machines.hold();
      expect(await machines.reach('nobody', 100)).toEqual({ ok: false, reason: 'it is no longer added' });
    } finally { await machines.close(); }
  });
});

describe('a chat picked on a machine that cannot be reached', () => {
  it('never opens: it throws what the list shows again, naming the machine and why -- and starts no ssh of its own', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { hosts, options } = withHosts('down');
    // The window's connections, with a machine that refuses.
    (await holdWindowMachines({}, options)).release();
    const said: string[] = [];
    const terminal = new Proxy({} as Record<string, unknown>, { get: (_t, key) => (key === 'activity' ? (line: string) => said.push(line) : () => undefined), set: () => true }) as never;
    const error = await runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, undefined, undefined, 1_000).then(() => undefined, (failure: Error) => failure);
    expect(error).toBeInstanceOf(RemoteUnavailable);
    expect(error!.message).toContain('devbox cannot be reached');
    expect(error!.message).toContain('Connection refused');
    // Only the window's own connection tried; the chat started none.
    expect(hosts.length).toBeGreaterThan(0);
  });
});
