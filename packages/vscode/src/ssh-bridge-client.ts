/** The existing multiplex bridge carried over SSH for a remote machine. */
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
// Whichever way this machine reaches another, that one can reach it back (remote/peer.ts).
import { startBridge } from '../../../src/remote/peer';
import type { IdeEvent, IdeHostEvent, IdeHostRequest, IdeRequest } from './protocol';
import type { Runtime } from './runtime';
import { MultiplexBridge } from './bridge-client';

export class SshBridgeClient extends MultiplexBridge {
  private readonly stderrClosed: Promise<void>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams, runtime: Runtime) {
    super(runtime, undefined);
    this.stderrClosed = new Promise<void>((resolve) => child.stderr.once('close', () => resolve()));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line) as IdeEvent | IdeHostEvent;
        // As BridgeClient: a `result` settles its call() here too (a one-chat bridge adopted by the pool).
        if (event && typeof event.type === 'string') this.receive(event as IdeEvent);
      } catch { this.emit('log', 'Remote ClikCode sent an invalid bridge message.'); }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const rows = stderr.split(/\r?\n/);
      stderr = rows.pop() ?? '';
      for (const row of rows) if (row.trim()) this.emit('log', row);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => this.emit('log', error.message));
    child.on('close', (code, signal) => {
      if (stderr.trim()) this.emit('log', stderr.trim());
      this.markExited(code, signal);
    });
  }

  static start(target: string, runtime: Runtime): SshBridgeClient {
    return new SshBridgeClient(startBridge(target), runtime);
  }

  send(request: IdeRequest): boolean { return this.post(request); }

  post(message: IdeRequest | IdeHostRequest): boolean {
    if (this.exited || this.child.stdin.destroyed) return false;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }

  logDrained(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.stderrClosed,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  dispose(): void {
    if (this.exited) return;
    this.post({ type: 'close' });
    this.child.stdin.end();
    setTimeout(() => { if (!this.exited) this.child.kill(); }, 3_000).unref();
  }
}
