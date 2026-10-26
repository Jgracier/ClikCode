/** Runs a computer tool in a chat's worker and waits for its scrubbed result.
 * Used by the MCP server and the CLI, so a harness that is not ClikCode's own
 * agent gets the same tools, prompts and secret handling.
 *
 * One connection to the worker serves every call this process makes, and is
 * opened again only once it is lost. It attached per call before: an MCP
 * server whose agent was browsing connected every 2-6 s (2026-10-21), and each
 * one was a snapshot sent, a window joining and leaving the chat, and, on
 * leaving with no other window open, the chat's MCP servers released. The
 * connection does not attach: a tool call carries the worker's token. */
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { WorkerClient, workerForCommands } from '../worker/client.js';
import { encodeFrame, FrameDecoder, type WorkerEvent } from '../worker/protocol.js';
import { listWorkerRecords, type WorkerRuntimeRecord } from '../worker/registry.js';
import { resolveChat } from './ai/harness.js';

/** The chat whose worker started this process: a worker's pid names one chat for its whole life. */
let turnChat: Promise<string | undefined> | undefined;

function chatOfWorker(workerPid: number): Promise<string | undefined> {
  turnChat ??= listWorkerRecords().then((records) => records.find(record => record.pid === workerPid)?.sessionId).then(
    (found) => { if (!found) turnChat = undefined; return found; },
    () => { turnChat = undefined; return undefined; },
  );
  return turnChat;
}

/** The chat a call belongs to: the one whose worker started this process, or
 * the one named. A running chat can use only its own. */
export async function callerSession(chat?: string): Promise<string> {
  const workerPid = Number(process.env.CLIKCODE_WORKER_PID);
  const fromTurn = Number.isSafeInteger(workerPid) && workerPid > 0 ? await chatOfWorker(workerPid) : undefined;
  const sessionId = chat ? await resolveChat(chat) : fromTurn;
  if (!sessionId) throw new Error('Run this from inside a ClikCode chat, or pass --chat <chat>.');
  if (fromTurn && sessionId !== fromTurn) throw new Error('A running chat can use these tools only in its own chat.');
  return sessionId;
}

const TEN_MINUTES = 10 * 60_000;
/** How long a worker has to say it took a call. One from before tool calls
 * needed no attach says nothing at all. */
const STARTED_MS = 5_000;
const OLDER_WORKER = 'This chat is still running an older ClikCode worker. Try again after its current turn finishes.';

type Call = { onEvent: (event: WorkerEvent) => void; onClose: () => void };

/** The one connection to a chat's worker. */
class ToolLine {
  private readonly calls = new Map<string, Call>();
  closed = false;
  private constructor(private readonly socket: Socket, readonly record: WorkerRuntimeRecord) {
    const frames = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const message of frames.push(chunk)) {
        const id = (message as { id?: unknown }).id;
        if (typeof id === 'string') this.calls.get(id)?.onEvent(message as WorkerEvent);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      lifecycle('client.worker.closed', { tools: true });
      for (const call of [...this.calls.values()]) call.onClose();
      this.calls.clear();
    });
    socket.on('error', () => socket.destroy());
    // Only a call in flight keeps this process running (the CLI exits after its one call).
    socket.unref();
  }

  static async open(record: WorkerRuntimeRecord): Promise<ToolLine> {
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const candidate = connect(record.socketPath);
      candidate.once('connect', () => { candidate.off('error', rejectSocket); resolveSocket(candidate); });
      candidate.once('error', rejectSocket);
    });
    lifecycle('client.worker.connect', { worker: record.sessionId, workerPid: record.pid, tools: true });
    return new ToolLine(socket, record);
  }

  /** Sends one call; returns what forgets it. */
  send(id: string, tool: string, args: Record<string, unknown>, call: Call): () => void {
    this.calls.set(id, call);
    this.socket.ref();
    this.socket.write(encodeFrame({ type: 'computer-tool', id, tool, args, token: this.record.token }));
    return () => {
      this.calls.delete(id);
      if (!this.calls.size) this.socket.unref();
    };
  }

  close(): void { this.socket.destroy(); }
}

const lines = new Map<string, Promise<ToolLine>>();
/** Workers (by pid) that ignored a call sent without an attach: asked the old way. */
const attachOnly = new Set<number>();

async function toolLine(sessionId: string): Promise<ToolLine> {
  const existing = lines.get(sessionId);
  if (existing) {
    const line = await existing.catch(quiet('commands/computer-tool-client'));
    if (line && !line.closed) return line;
    if (lines.get(sessionId) === existing) lines.delete(sessionId);
    else return toolLine(sessionId);
  }
  const opening = workerForCommands(sessionId).then((record) => ToolLine.open(record));
  lines.set(sessionId, opening);
  opening.catch(() => { if (lines.get(sessionId) === opening) lines.delete(sessionId); });
  return opening;
}

type Outcome = { ok: boolean; output: string };

/** Waits for one call's answer: taken within STARTED_MS, finished within ten minutes. */
function awaitCall(
  signal: AbortSignal | undefined,
  start: (call: Call) => () => void,
  notTaken: () => Error,
): Promise<Outcome> {
  return new Promise<Outcome>((resolve, reject) => {
    let forget: () => void = () => undefined;
    let timer = setTimeout(() => { done(); reject(notTaken()); }, STARTED_MS);
    const done = (): void => { clearTimeout(timer); forget(); signal?.removeEventListener('abort', onAbort); };
    const onAbort = (): void => { done(); reject(new Error('Stopped.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    forget = start({
      onClose: () => { done(); reject(new Error('The ClikCode chat disconnected.')); },
      onEvent: (event) => {
        if (event.type === 'computer-tool-started') {
          clearTimeout(timer);
          timer = setTimeout(() => { done(); reject(new Error('The tool did not finish in time.')); }, TEN_MINUTES);
          return;
        }
        if (event.type !== 'computer-tool-result') return;
        done(); resolve({ ok: event.ok, output: event.output });
      },
    });
  });
}

class NotTaken extends Error {}

export async function callWorkerTool(input: {
  chat?: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal;
}): Promise<Outcome> {
  const sessionId = await callerSession(input.chat);
  const line = await toolLine(sessionId);
  if (!attachOnly.has(line.record.pid)) {
    const id = randomUUID();
    try {
      return await awaitCall(input.signal, (call) => line.send(id, input.tool, input.args, call), () => new NotTaken());
    } catch (error) {
      if (!(error instanceof NotTaken)) throw error;
      // Said nothing: a worker from before calls without an attach. Asked the old way from now on.
      attachOnly.add(line.record.pid);
    }
  }
  return callAttached(sessionId, input);
}

/** The call as a worker from before tool calls without an attach takes it. */
async function callAttached(sessionId: string, input: { tool: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<Outcome> {
  const client = await WorkerClient.attach(sessionId);
  const id = randomUUID();
  try {
    return await awaitCall(input.signal, (call) => {
      const onEvent = (event: WorkerEvent): void => { if ((event as { id?: unknown }).id === id) call.onEvent(event); };
      client.on('event', onEvent);
      client.on('close', call.onClose);
      client.send({ type: 'computer-tool', id, tool: input.tool, args: input.args });
      return () => { client.off('event', onEvent); client.off('close', call.onClose); };
    }, () => new Error(OLDER_WORKER));
  } finally { client.close(); }
}

/** For tests: forget every connection. */
export function closeToolLines(): void {
  for (const opening of lines.values()) void opening.then((line) => line.close(), () => undefined);
  lines.clear();
  attachOnly.clear();
  turnChat = undefined;
}
