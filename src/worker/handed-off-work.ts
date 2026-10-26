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
import { readState } from '../session/state/read.js';
import { carryBlockedSubagent } from './subagent-recovery.js';

/** What the model is told of `ended`. */
export function formatEndedWork(ended: readonly EndedWork[], from: { harness?: string } = {}): string {
  return ended.map((work) => {
    const tail = work.tail.replace(/\s+$/, '');
    if (work.kind === 'command') return `[background command ${work.id} finished] ${work.label}\n${tail || '(no output)'}`;
    if (work.outcome === 'finished') return `[background agent ${work.id} finished] ${work.label}\n${tail || '(it gave no result)'}`;
    const why = work.limit ?? (tail || 'it stopped before it finished');
    const resume = from.harness === 'claude'
      ? `Resume the existing native agent ${JSON.stringify(work.id)} on this account using SendMessage (to that agent ID) or the agent tool's resume control. Its prior history must be preserved; do not launch a duplicate from scratch.`
      : 'Continue this unfinished subagent on the current available account. Use its native resume control when supported.';
    const context = work.outputFile
      ? `Its saved transcript is ${JSON.stringify(work.outputFile)}. If native resume is unavailable, read that transcript in bounded sections and give a replacement agent its prior context and progress. Continue from the last unfinished step; do not repeat completed actions.`
      : 'Preserve its recorded progress and completed actions when continuing; do not repeat completed work.';
    const task = `${resume}\n${context}${tail ? `\nProgress before interruption:\n${tail}` : ''}`
      + (work.prompt ? `\nOriginal task:\n${work.prompt}` : `\nUse the recorded task description: ${work.label}`);
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
      let canResumeClaude = false;
      if (from.harness === 'claude' && ended.some((work) => work.outcome === 'cut-off')) {
        const state = await readState({ transcripts: [] });
        const session = state.sessions.find((entry) => entry.id === ctx.sessionId);
        if (session) {
          canResumeClaude = session.nativeHarness === 'claude';
          const source = state.accounts.find((entry) => entry.id === from.accountId);
          const target = state.accounts.find((entry) => entry.id === session.accountId);
          for (const work of ended.filter((entry) => entry.kind === 'agent' && entry.outcome === 'cut-off')) {
            await carryBlockedSubagent(work, session, source, target).catch((error: unknown) =>
              diagnostic('worker.subagent-carry-failed', error instanceof Error ? error.message : String(error)));
          }
        }
      }
      // Native agent IDs are meaningful only inside the Claude conversation that
      // owns them. A provider handoff must use the saved transcript instead.
      await ctx.io.recordNotificationText(formatEndedWork(ended, canResumeClaude ? from : {}), true);
      ctx.io.broadcastQueueChanged();
      if (!ctx.turnRunning) await ctx.queue.drainQueue();
    })().catch((error: unknown) => diagnostic('worker.work-ended-undelivered', error instanceof Error ? error.message : String(error)))
      .finally(() => ctx.idle.scheduleIdleExit());
  };
}
