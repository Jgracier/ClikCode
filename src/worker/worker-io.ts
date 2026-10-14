/** Reading the conversation, and telling every window about it. */
import { randomUUID } from 'node:crypto';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { enqueueSessionTurn } from '../turn/checkpoint.js';
import { formatShellNotifications, type ShellNotification } from '../agent/session-state.js';
import type { WorkerContext } from './worker-context.js';

export function createWorkerIo(ctx: WorkerContext) {
  const { observer, sessionId } = ctx;
  const currentSessionAndAccount = async (): Promise<{ session: HarnessSession; account?: string }> => {
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) throw new Error(`AI session "${sessionId}" was not found`);
    const account = found.accountId ? latest.accounts.find((item) => item.id === found.accountId)?.label : undefined;
    return { session: found, account };
  };

  /** One muted line in the chat, from the turn if one runs (saved with it). */
  const note = (message: string): void => observer.activity(message);

  const broadcastQueueChanged = (): void => {
    observer.broadcast({ type: 'queue-changed' });
    showEveryWindow();
  };

  /** Mid-turn, every window is showing the turn, and a message typed in one
   * of them -- steered into it or queued behind it -- belongs on all of them
   * now, not when the turn ends. The snapshot carries both (the journal's
   * steers, the queue); each window already draws them from there. */
  const showEveryWindow = (): void => {
    if (!ctx.turnRunning) return;
    // The read is async: one that resolves after this turn ended holds an
    // older session (still with its pendingTurn), and drawing it would undo
    // the turn's final snapshot.
    const controller = ctx.activeController;
    void currentSessionAndAccount().then(({ session: current, account }) => {
      if (!ctx.turnRunning || ctx.activeController !== controller) return;
      observer.render(current, account);
    }).catch(() => undefined);
  };

  /** Shell notifications become a queued turn the model alone reads: run
   * through the same queue as a message typed during a turn, and never
   * drawn. Only the live worker records them; a stopping one does not. */
  const recordNotifications = async (notes: readonly ShellNotification[]): Promise<void> => {
    if (!notes.length) return;
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) return;
    const submittedAt = new Date().toISOString();
    enqueueSessionTurn(found, { id: randomUUID(), text: formatShellNotifications(notes), submittedAt, kind: 'notification' }, submittedAt);
    await writeState(latest);
  };
  return { currentSessionAndAccount, note, broadcastQueueChanged, showEveryWindow, recordNotifications };
}

export type WorkerIo = ReturnType<typeof createWorkerIo>;
