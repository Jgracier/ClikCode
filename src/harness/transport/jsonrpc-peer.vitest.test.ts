import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcPeer } from './jsonrpc-peer.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  sent: Array<Record<string, any>> = [];
  /** Signals that actually end the fake process. */
  diesOn: NodeJS.Signals[] = ['SIGTERM', 'SIGKILL'];
  private buffer = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      const lines = (this.buffer + String(chunk)).split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.sent.push(JSON.parse(line));
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    if (this.diesOn.includes(signal)) this.die(null, signal);
    return true;
  }

  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  say(message: unknown): void { this.stdout.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`); }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const peerFor = (child: FakeChild, options: Partial<ConstructorParameters<typeof JsonRpcPeer>[1]> = {}): JsonRpcPeer =>
  new JsonRpcPeer(child as unknown as ChildProcess, { label: 'fake', forwardParentSignals: false, ...options });

afterEach(() => { vi.useRealTimers(); });

describe('JSON-RPC peer', () => {
  it('routes responses, buffers partial lines, and keeps non-JSON stdout as noise', async () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    const result = peer.request('initialize', { a: 1 });
    await tick();
    expect(child.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
    child.stdout.write('Booting agent...\n{"jsonrpc":"2.0","id":1,');
    child.stdout.write('"result":{"ok":true}}\n');
    await expect(result).resolves.toEqual({ ok: true });
    expect(peer.failureDetail()).toBe('Booting agent...');
  });

  it('omits the jsonrpc member for servers that do not use it', async () => {
    const child = new FakeChild();
    const peer = peerFor(child, { jsonrpcVersion: false });
    peer.notify('initialized');
    await tick();
    expect(child.sent[0]).toEqual({ method: 'initialized' });
  });

  it('surfaces JSON-RPC errors with their code', async () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    const result = peer.request('session/new', {});
    child.say({ id: 1, error: { code: -32000, message: 'Authentication required' } });
    await expect(result).rejects.toMatchObject({ message: 'Authentication required', rpcCode: -32000 });
  });

  it('never lets EPIPE on stdin become an uncaught exception, and send is a no-op after close', async () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.die(1);
    await tick();
    process.off('uncaughtException', uncaught);
    expect(uncaught).not.toHaveBeenCalled();
    const before = child.sent.length;
    expect(peer.send({ method: 'late' })).toBe(false);
    expect(peer.notify('late')).toBe(false);
    await expect(peer.request('late', {})).rejects.toThrow(/exited 1/);
    await tick();
    expect(child.sent.length).toBe(before);
  });

  it('does not throw when stdin was already destroyed', () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    child.stdin.destroy();
    expect(peer.send({ method: 'x' })).toBe(false);
  });

  it('rejects every pending request when the child exits, using stderr as the reason', async () => {
    const child = new FakeChild();
    const onClose = vi.fn();
    const peer = peerFor(child, { onClose });
    const first = peer.request('session/prompt', {});
    const second = peer.request('turn/steer', {});
    child.stderr.write('fatal: not logged in\n');
    await tick();
    child.die(1);
    await expect(first).rejects.toThrow('fatal: not logged in');
    await expect(second).rejects.toThrow('fatal: not logged in');
    expect(peer.pendingCount).toBe(0);
    expect(peer.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still settles when exit arrives but close never does', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const peer = peerFor(child);
    const stuck = peer.request('session/prompt', {});
    const assertion = expect(stuck).rejects.toThrow(/exited 3/);
    child.exitCode = 3;
    child.emit('exit', 3, null);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(peer.closed).toBe(true);
  });

  it('reads a final response that arrives between exit and close', async () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    const result = peer.request('session/prompt', {});
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.write('{"id":1,"result":{"stopReason":"end_turn"}}');
    await tick();
    child.emit('close', 0, null);
    await expect(result).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('rejects only matching requests on a turn-scoped rejectPending', async () => {
    const child = new FakeChild();
    const peer = peerFor(child);
    const prompt = peer.request('session/prompt', {});
    const steer = peer.request('turn/steer', {});
    peer.rejectPending(new Error('turn ended'), (method) => method === 'turn/steer');
    await expect(steer).rejects.toThrow('turn ended');
    expect(peer.pendingCount).toBe(1);
    child.say({ id: 1, result: {} });
    await expect(prompt).resolves.toEqual({});
  });

  it('times out a request that opts in and leaves untimed requests alone', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const peer = peerFor(child);
    const setup = peer.request('initialize', {}, { timeoutMs: 20_000 });
    const prompt = peer.request('session/prompt', {});
    const settled = vi.fn();
    prompt.then(settled, settled);
    const assertion = expect(setup).rejects.toMatchObject({ code: 'ERR_JSONRPC_TIMEOUT', message: 'fake initialize timed out after 20s' });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).not.toHaveBeenCalled();
    expect(peer.pendingCount).toBe(1);
  });

  it('restarts an idle-reset timeout whenever the server is still talking', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const peer = peerFor(child);
    const settled = vi.fn();
    const load = peer.request('session/load', {}, { timeoutMs: 1000, idleReset: true });
    load.then(settled, settled);
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(800);
      child.say({ method: 'session/update', params: {} });
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('routes notifications and server requests, answering unknown methods with -32601', async () => {
    const child = new FakeChild();
    const notes: string[] = [];
    peerFor(child, {
      onNotification: (method) => { notes.push(method); },
      onRequest: (method) => method === 'known' ? Promise.resolve({ fine: true }) : method === 'broken' ? Promise.reject(new Error('boom')) : undefined,
    });
    child.say({ method: 'session/update', params: {} });
    child.say({ id: 7, method: 'known', params: {} });
    child.say({ id: 'abc', method: 'fs/read_text_file', params: {} });
    child.say({ id: 9, method: 'broken', params: {} });
    await tick();
    await tick();
    expect(notes).toEqual(['session/update']);
    expect(child.sent).toContainEqual({ jsonrpc: '2.0', id: 7, result: { fine: true } });
    expect(child.sent).toContainEqual({ jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'Unsupported client method: fs/read_text_file' } });
    expect(child.sent).toContainEqual({ jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'boom' } });
  });

  it('shuts down politely when the child leaves on stdin EOF', async () => {
    const child = new FakeChild();
    child.stdin.on('end', () => child.die(0));
    const peer = peerFor(child);
    await peer.shutdown();
    expect(child.killed).toEqual([]);
  });

  it('escalates cancel -> SIGTERM -> SIGKILL on a child that ignores everything', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.diesOn = ['SIGKILL'];
    const peer = peerFor(child);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const done = peer.shutdown({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(child.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(child.killed).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(2998);
    expect(child.killed).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(3);
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
    await done;
    expect(peer.closed).toBe(true);
  });

  it('stops escalating once SIGTERM worked', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const peer = peerFor(child);
    const done = peer.shutdown();
    await vi.advanceTimersByTimeAsync(2001);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('targets the process group of a detached child', () => {
    if (process.platform === 'win32') return;
    const child = new FakeChild();
    (child as unknown as { pid: number }).pid = 424242;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      peerFor(child, { detached: true }).kill('SIGTERM');
      expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM');
      expect(child.killed).toEqual([]);
    } finally { kill.mockRestore(); }
  });

  it('forwards parent termination signals to the child tree and unhooks on exit', () => {
    const child = new FakeChild();
    const before = process.listeners('SIGTERM');
    const interruptsBefore = process.listenerCount('SIGINT');
    new JsonRpcPeer(child as unknown as ChildProcess, { label: 'fake' });
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    expect(process.listenerCount('SIGINT')).toBe(interruptsBefore + 1);
    // Invoke the handler directly: emitting a real SIGTERM would also reach
    // the test runner's own listeners.
    (added[0] as () => void)();
    expect(child.killed).toEqual(['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(before.length);
    expect(process.listenerCount('SIGINT')).toBe(interruptsBefore);
  });
});
