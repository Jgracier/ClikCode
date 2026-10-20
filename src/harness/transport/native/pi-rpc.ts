/** Pi's RPC mode (`pi --mode rpc`, docs/rpc.md): one JSON command per stdin
 * line, events and `response`s per stdout line. A `steer` sent while the
 * agent runs is delivered after the current tool calls and before the next
 * model call -- nothing is interrupted (verified against pi 0.87.0, a tool
 * running 6 s was not cut short and the next model call carried the message). */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** The `prompt` command; images inline as base64 (`@file` is refused in RPC mode). */
export async function piRpcPrompt(text: string, imagePaths: readonly string[]): Promise<string> {
  const images = [];
  for (const path of imagePaths) {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (mimeType) images.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType });
  }
  return `${JSON.stringify({ type: 'prompt', message: text, ...(images.length ? { images } : {}) })}\n`;
}

/** The `steer` command; `id` correlates the `response` that says whether it was taken. */
export function piRpcSteer(id: string, text: string): string {
  return `${JSON.stringify({ id, type: 'steer', message: text })}\n`;
}

/** After `agent_end` pi may still retry, compact or run a queued message;
 * `agent_settled` says it will not. A pi too old to send it is closed this
 * long after `agent_end` instead. */
const PI_SETTLE_FALLBACK_MS = 15_000;

/** Tracks one pi RPC turn: which steers still await their `response`, and
 * when the turn is over and stdin may be closed. */
export function createPiRpcTurn(options: { close: () => void; fallbackMs?: number }) {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(new Error('turn is finishing')); }
    options.close();
  };
  return {
    get settled() { return settled; },
    /** Resolves once pi accepted the steer; rejects when it refused or the turn ended first. */
    await(id: string): Promise<void> {
      return new Promise((resolve, reject) => {
        if (settled) return reject(new Error('turn is finishing'));
        pending.set(id, { resolve, reject });
      });
    },
    /** Every stdout record, parsed. */
    note(record: Record<string, unknown>): void {
      const type = record.type;
      if (type === 'response' && record.command === 'steer' && typeof record.id === 'string') {
        const waiter = pending.get(record.id);
        pending.delete(record.id);
        if (record.success === true) waiter?.resolve();
        else waiter?.reject(new Error(typeof record.error === 'string' ? record.error : 'pi refused the message'));
      } else if (type === 'agent_settled') settle();
      else if (type === 'agent_end') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(settle, options.fallbackMs ?? PI_SETTLE_FALLBACK_MS);
      } else if (type === 'agent_start' && timer) { clearTimeout(timer); timer = undefined; }
    },
    /** The process is gone: whatever still waited was never taken. */
    ended(): void {
      settled = true;
      if (timer) clearTimeout(timer);
      for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(new Error('pi exited')); }
    },
  };
}
