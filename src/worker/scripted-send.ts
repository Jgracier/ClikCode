/** A turn sent from a script -- `clikcode send`, `sessions send`, a headless
 * slash command -- into a conversation a worker may be serving.
 *
 * These ran the turn in-process whatever else was running it. With a worker
 * mid-turn, the second turn's checkpoint marked the worker's journal finished
 * (beginPendingTurn), both wrote the whole transcript, and the last writer
 * won. Now a worker runs it, queued behind a running turn exactly as a
 * message typed in a window is -- started for it when none is running, so
 * what the turn leaves running (a background shell, a vendor's background
 * work) has an owner after this process exits: its exit reaches the model,
 * and nothing is orphaned. Only when no worker can start does it run here,
 * holding the conversation so none starts mid-turn. */
import type Conf from 'conf';
import { stdout as output } from 'node:process';
import { WorkerClient } from './client.js';
import { takeConversation } from './registry.js';
import type { WorkerEvent } from './protocol.js';
import { runSessionTurn } from '../turn/session-turn.js';
import { consumeSessionTurn, enqueueSessionTurn, sessionTranscriptMessages } from '../turn/checkpoint.js';
import { randomUUID } from 'node:crypto';
import { disposeSessionState, formatShellNotifications } from '../agent/session-state.js';
import { stateDirectory } from '../session/store/paths.js';
import { textTranscript } from '../turn/turn-activities.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitHarnessOutput } from '../harness/output.js';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import { turnCancelledError } from '../agent/cancellation.js';

export async function sendScriptedTurn(config: Conf, sessionId: string, prompt: string, signal?: AbortSignal): Promise<void> {
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  let spawnFailed = false;
  for (;;) {
    if (signal?.aborted) throw turnCancelledError();
    const client = await WorkerClient.attachExisting(sessionId).catch(() => undefined)
      ?? (spawnFailed ? undefined : await WorkerClient.attach(sessionId).catch(() => { spawnFailed = true; return undefined; }));
    if (client) {
      try {
        if (await turnThroughWorker(client, sessionId, text, signal)) return;
      } finally {
        client.send({ type: 'detach' });
        client.close();
      }
      continue;
    }
    const taken = await takeConversation(sessionId, 'turn');
    if ('hold' in taken) {
      try {
        return await runSessionTurn(config, sessionId, text, signal);
      } finally {
        // No worker will own what the turn left running: stop it, and queue
        // what the model is owed for whoever opens the conversation next.
        await settleInProcessWork(sessionId).catch(() => undefined);
        await taken.hold.release();
      }
    }
    // A worker is coming up (it answers in a moment), or another scripted
    // turn is running here (this one goes after it).
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

/** True once the turn has run; false when the worker went away before it
 * started, and the message was taken back out of its queue to be sent again. */
function turnThroughWorker(client: WorkerClient, sessionId: string, text: string, signal?: AbortSignal): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const initial = client.initialEvent;
  /** Whether any turn is running, and whether it is this one. */
  let running = initial?.type === 'snapshot' && Boolean(initial.live);
  let ours = false;
  let queuedTurnId: string | undefined;
  let failure: Error | undefined;
  let stopping = false;
  return new Promise<boolean>((resolveTurn, rejectTurn) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      client.off('event', onEvent);
      client.off('close', onGone);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const dequeue = async (): Promise<void> => {
      if (!queuedTurnId) return;
      const state = await readState({ transcripts: [sessionId] });
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session && consumeSessionTurn(session, queuedTurnId)) await writeState(state);
    };
    /** Queued behind another turn: sent again once it is at the head of the
     * queue and nothing is running -- which a window also does, and the
     * worker runs it once whoever asks first. */
    const sendWhenDue = async (): Promise<void> => {
      if (!queuedTurnId || running || ours) return;
      const session = (await readState({ transcripts: [sessionId] })).sessions.find((item) => item.id === sessionId);
      const queue = session?.queuedTurns ?? [];
      if (!queue.some((item) => item.id === queuedTurnId)) {
        finish(() => rejectTurn(new Error('The queued message was removed before it ran.')));
        return;
      }
      if (queue[0]?.id === queuedTurnId && !running && !ours) client.send({ type: 'submit', text, echo: true, queuedTurnId });
    };
    const done = async (): Promise<void> => {
      if (failure) { finish(() => rejectTurn(failure)); return; }
      if (stopping) { finish(() => rejectTurn(turnCancelledError())); return; }
      const state = await readState({ transcripts: [sessionId] });
      const session = state.sessions.find((item) => item.id === sessionId);
      const answer = session ? textTranscript(sessionTranscriptMessages(session)).at(-1) : undefined;
      const invocation = state.invocations.filter((item) => item.sessionId === sessionId && item.at >= startedAt).at(-1);
      emitHarnessOutput({
        session, text: answer?.role === 'assistant' ? answer.content : '',
        ...(invocation ? { invocation } : {}), ...(session?.lastUsage ? { usage: session.lastUsage } : {}),
      });
      finish(() => resolveTurn(true));
    };
    const onEvent = (event: WorkerEvent): void => {
      switch (event.type) {
        case 'submit-queued':
          queuedTurnId = event.queuedTurnId;
          return;
        case 'waiting-start':
          running = true;
          if (event.prompt?.trim() === text) ours = true;
          return;
        case 'snapshot':
          if (event.live) running = true;
          if (event.live?.prompt?.trim() === text) ours = true;
          return;
        case 'activity':
          if (ours && !isJsonDefaultMode()) for (const line of renderActivityLine(event.event)) output.write(`${line}\n`);
          return;
        case 'note':
          // A note says something is missing from the turn (an MCP server that
          // would not start): JSON output keeps stdout to the result, so it
          // goes to stderr rather than nowhere.
          if (ours) (isJsonDefaultMode() ? process.stderr : output).write(`${event.message}\n`);
          return;
        case 'turn-error':
          if (ours) failure = new Error(event.message);
          return;
        case 'waiting-stop':
          running = false;
          if (ours) void done().catch((error: unknown) => finish(() => rejectTurn(error)));
          else void sendWhenDue().catch((error: unknown) => finish(() => rejectTurn(error)));
          return;
        case 'queue-changed':
          void sendWhenDue().catch(() => undefined);
          return;
        case 'shutdown':
          onGone();
          return;
        default:
      }
    };
    const onGone = (): void => {
      if (ours) { finish(() => rejectTurn(new Error('session worker exited mid-turn'))); return; }
      // Not started: taken back out of the queue, and sent again wherever it
      // can run now.
      void dequeue().then(() => finish(() => resolveTurn(false)), (error: unknown) => finish(() => rejectTurn(error)));
    };
    const onAbort = (): void => {
      stopping = true;
      if (ours) { client.send({ type: 'cancel', restoreDraft: false }); return; }
      void dequeue().then(() => finish(() => rejectTurn(turnCancelledError())), (error: unknown) => finish(() => rejectTurn(error)));
    };
    client.on('event', onEvent);
    client.on('close', onGone);
    signal?.addEventListener('abort', onAbort, { once: true });
    client.send({ type: 'submit', text, echo: true });
  });
}

/** After a turn run here (no worker could start): background shells it
 * started are stopped -- they are detached, and would otherwise outlive this
 * process with nobody to report them -- and each, with any notification not
 * yet delivered, is queued as a turn for the next worker. */
async function settleInProcessWork(sessionId: string): Promise<void> {
  const undelivered = disposeSessionState(stateDirectory(), sessionId, 'the command that started it ended and no ClikCode worker could keep it');
  if (!undelivered.length) return;
  const state = await readState({ transcripts: [sessionId] });
  const found = state.sessions.find((item) => item.id === sessionId);
  if (!found) return;
  const submittedAt = new Date().toISOString();
  enqueueSessionTurn(found, { id: randomUUID(), text: formatShellNotifications(undelivered), submittedAt, kind: 'notification' }, submittedAt);
  await writeState(state);
}
