/** Runs a computer tool in a chat's worker and waits for its scrubbed result.
 * Used by the MCP server and the CLI, so a harness that is not ClikCode's own
 * agent gets the same tools, prompts and secret handling. */
import { randomUUID } from 'node:crypto';
import { WorkerClient } from '../worker/client.js';
import { listWorkerRecords } from '../worker/registry.js';
import type { WorkerEvent } from '../worker/protocol.js';
import { resolveChat } from './ai/harness.js';

/** The chat a call belongs to: the one whose worker started this process, or
 * the one named. A running chat can use only its own. */
export async function callerSession(chat?: string): Promise<string> {
  const workerPid = Number(process.env.CLIKCODE_WORKER_PID);
  const fromTurn = Number.isSafeInteger(workerPid) && workerPid > 0
    ? (await listWorkerRecords()).find(record => record.pid === workerPid)?.sessionId
    : undefined;
  const sessionId = chat ? await resolveChat(chat) : fromTurn;
  if (!sessionId) throw new Error('Run this from inside a ClikCode chat, or pass --chat <chat>.');
  if (fromTurn && sessionId !== fromTurn) throw new Error('A running chat can use these tools only in its own chat.');
  return sessionId;
}

const TEN_MINUTES = 10 * 60_000;

export async function callWorkerTool(input: {
  chat?: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal;
}): Promise<{ ok: boolean; output: string }> {
  const sessionId = await callerSession(input.chat);
  const client = await WorkerClient.attach(sessionId);
  const id = randomUUID();
  try {
    return await new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
      let timer = setTimeout(() => { done(); reject(new Error('This chat is still running an older ClikCode worker. Try again after its current turn finishes.')); }, 5_000);
      const done = (): void => { clearTimeout(timer); client.off('event', onEvent); client.off('close', onClose); input.signal?.removeEventListener('abort', onAbort); };
      const onClose = (): void => { done(); reject(new Error('The ClikCode chat disconnected.')); };
      const onAbort = (): void => { done(); reject(new Error('Stopped.')); };
      const onEvent = (event: WorkerEvent): void => {
        if (event.type === 'computer-tool-started' && event.id === id) {
          clearTimeout(timer);
          timer = setTimeout(() => { done(); reject(new Error('The tool did not finish in time.')); }, TEN_MINUTES);
          return;
        }
        if (event.type !== 'computer-tool-result' || event.id !== id) return;
        done(); resolve({ ok: event.ok, output: event.output });
      };
      client.on('event', onEvent);
      client.on('close', onClose);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      client.send({ type: 'computer-tool', id, tool: input.tool, args: input.args });
    });
  } finally { client.close(); }
}
