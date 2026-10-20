/** The worker's side of work a vendor process ran on after the conversation left it, and of
 * agents the account's usage limit cut off (harness/transport/handoff-work.ts): each end becomes a
 * notification the conversation's account of the moment reads -- a result to use, or an agent's
 * task to start again -- run as a turn of its own through the queue, as a shell ClikCode's own
 * agent left running is (worker-queue.ts deliverNotifications). An agent the limit cut off also
 * marks its account spent, so that turn runs on the next one. */
import { diagnostic, lifecycle } from '../runtime/lifecycle-log.js';
import { storeQuotaRefusal } from '../turn/account-outcome.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';
import type { WorkEndedHandler } from '../turn/vendor-process.js';
import type { WorkerContext } from './worker-context.js';

/** What the model is told of `ended`. */
export function formatEndedWork(ended: readonly EndedWork[]): string {
  return ended.map((work) => {
    const tail = work.tail.replace(/\s+$/, '');
    if (work.kind === 'command') return `[background command ${work.id} finished] ${work.label}\n${tail || '(no output)'}`;
    if (work.outcome === 'finished') return `[background agent ${work.id} finished] ${work.label}\n${tail || '(it gave no result)'}`;
    const why = work.limit ?? (tail || 'it stopped before it finished');
    const task = work.prompt
      ? `It ran on the account this conversation has moved off, and did not finish. Start it again here, with the same task:\n${work.prompt}`
      : 'It ran on the account this conversation has moved off, and did not finish. Its task was not recorded: start it again from its description if it is still needed.';
    return `[background agent ${work.id} was cut off: ${why}] ${work.label}\n${task}`;
  }).join('\n\n');
}

export function createWorkEndedHandler(ctx: WorkerContext): WorkEndedHandler {
  return (ended, from) => {
    if (!ended.length) return;
    lifecycle('worker.work-ended', { count: ended.length, cut: ended.filter((work) => work.outcome === 'cut-off').length, account: from.accountId?.slice(0, 8) });
    void (async () => {
      // The vendor's own "you are out": its account is spent, and the notification turn runs on the next one.
      const limit = ended.find((work) => work.limit)?.limit;
      if (limit && from.accountId) await storeQuotaRefusal(from.accountId, new Error(limit));
      await ctx.io.recordNotificationText(formatEndedWork(ended));
      ctx.io.broadcastQueueChanged();
      if (!ctx.turnRunning) await ctx.queue.drainQueue();
    })().catch((error: unknown) => diagnostic('worker.work-ended-undelivered', error instanceof Error ? error.message : String(error)))
      .finally(() => ctx.idle.scheduleIdleExit());
  };
}
