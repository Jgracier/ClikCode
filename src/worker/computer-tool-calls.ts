/** A computer tool call runs once per call id, however many times it is asked for. A caller that heard nothing within its few seconds
 * (a worker stalled on disk, say) asks again the old way with the same id (commands/computer-tool-client.ts); a second run would
 * repeat what the first did at a site (two keys created). A repeat joins the run in flight, or is answered with its result. */
import { turnCancelledError } from '../agent/cancellation.js';
import type { Socket } from 'node:net';
import { quiet } from '../runtime/lifecycle-log.js';

export interface ToolCallResult { ok: boolean; output: string }

/** How long a finished call's result is kept for a late repeat. */
const KEEP_MS = 10 * 60_000;

interface Entry { waiters: Set<Socket>; result?: ToolCallResult; controller: AbortController }

export class ToolCalls {
  private readonly running = new Set<Promise<void>>();
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly send: (socket: Socket, event: { type: 'computer-tool-started'; id: string } | ({ type: 'computer-tool-result'; id: string } & ToolCallResult)) => void, private readonly keepMs = KEEP_MS) {}

  /** Runs `run` for `id` unless it already runs or ran; `socket` hears that it started and, when it ends, its result. The run is
   * stopped only when every socket waiting on it has closed. */
  take(socket: Socket, id: string, run: (signal: AbortSignal) => Promise<ToolCallResult>): void {
    this.send(socket, { type: 'computer-tool-started', id });
    const known = this.entries.get(id);
    if (known) {
      if (known.result) this.send(socket, { type: 'computer-tool-result', id, ...known.result });
      else this.wait(known, socket);
      return;
    }
    const entry: Entry = { waiters: new Set(), controller: new AbortController() };
    this.entries.set(id, entry);
    this.wait(entry, socket);
    const running = run(entry.controller.signal).catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) })).then((result) => {
      entry.result = result;
      for (const waiter of entry.waiters) if (!waiter.destroyed) this.send(waiter, { type: 'computer-tool-result', id, ...result });
      entry.waiters.clear();
      const timer = setTimeout(() => { if (this.entries.get(id) === entry) this.entries.delete(id); }, this.keepMs);
      timer.unref?.();
    }).catch(quiet('worker/computer-tool-calls'));
    this.running.add(running);
    void running.then(() => this.running.delete(running));
  }

  /** A model's final answer is not completion of tools it left awaiting human input.
   * Wait through the result (including saving it), unless the user stops the turn. */
  async settled(signal?: AbortSignal): Promise<void> {
    if (!this.running.size) return;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(turnCancelledError());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      while (this.running.size) await Promise.race([Promise.all([...this.running]), cancelled]);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private wait(entry: Entry, socket: Socket): void {
    entry.waiters.add(socket);
    socket.once('close', () => {
      entry.waiters.delete(socket);
      if (!entry.result && !entry.waiters.size) entry.controller.abort();
    });
  }
}
