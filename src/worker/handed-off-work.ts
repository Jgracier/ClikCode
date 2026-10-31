/** The worker's side of work a vendor process ran, and of agents the account's usage limit cut
 * off (turn/vendor-process.ts reportEndedWork is the ledger that decides what is told): each end
 * becomes a notification the conversation's account of the moment reads -- a result to use, or an
 * agent's task to start again -- run as a turn of its own through the queue, as a shell ClikCode's
 * own agent left running is (worker-queue.ts deliverNotifications).
 *
 * By the time this runs the ledger has already read the evidence: an account the work's end showed
 * spent is marked, and the conversation is on the next one, so this turn runs there. */
import { diagnostic, lifecycle } from '../runtime/lifecycle-log.js';
import type { EndedWork, RunningWork } from '../harness/transport/handoff-work.js';
import type { WorkEndedHandler } from '../turn/vendor-process.js';
import type { WorkerContext } from './worker-context.js';
import { readState } from '../session/state/read.js';
import { carryBlockedSubagent, locateAgentTranscript } from './subagent-recovery.js';

/** What the model is told of `ended`. `native`: the ids of the agents whose own history was carried to
 * the conversation's account, which can be resumed by the vendor as they were. Every other agent that
 * was cut off is taken up again from what ClikCode has of it: its task, what it had done, and its
 * saved transcript -- the same on every harness. */
export function formatEndedWork(ended: readonly EndedWork[], native: ReadonlySet<string> = new Set()): string {
  return ended.map((work) => {
    const tail = work.tail.replace(/\s+$/, '');
    if (work.kind === 'command') return `[background command ${work.id} finished] ${work.label}\n${tail || '(no output)'}`;
    if (work.outcome === 'finished') return `[background agent ${work.id} finished] ${work.label}\n${tail || '(it gave no result)'}`;
    const why = work.failure?.text ?? (tail || 'it stopped before it finished');
    const resume = native.has(work.id)
      ? `Resume the existing native agent ${JSON.stringify(work.id)} on this account using SendMessage (to that agent ID) or the agent tool's resume control. Its prior history must be preserved; do not launch a duplicate from scratch.`
      : 'Start a replacement agent on the current account to carry this unfinished work on.';
    const context = work.outputFile
      ? `Its saved transcript is ${JSON.stringify(work.outputFile)}. Read it in bounded sections and give the replacement its prior context and progress. Continue from the last unfinished step; do not repeat completed actions.`
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
      // The vendor's own history can be resumed only where it can be carried (a Claude agent to another
      // Claude account); everything else is taken up again from the replay in the notification.
      const native = new Set<string>();
      const cut = ended.filter((work) => work.kind === 'agent' && work.outcome === 'cut-off');
      if (cut.length) {
        const state = await readState({ transcripts: [] });
        const session = state.sessions.find((entry) => entry.id === ctx.sessionId);
        if (session) {
          const source = state.accounts.find((entry) => entry.id === from.accountId);
          const target = state.accounts.find((entry) => entry.id === session.accountId);
          for (const work of cut) {
            const carried = await carryBlockedSubagent(work, session, source, target).catch((error: unknown) => {
              diagnostic('worker.subagent-carry-failed', error instanceof Error ? error.message : String(error));
              return false;
            });
            if (carried) native.add(work.id);
          }
        }
      }
      await ctx.io.recordNotificationText(formatEndedWork(ended, native), true);
      ctx.io.broadcastQueueChanged();
      if (!ctx.turnRunning) await ctx.queue.drainQueue();
    })().catch((error: unknown) => diagnostic('worker.work-ended-undelivered', error instanceof Error ? error.message : String(error)))
      .finally(() => ctx.idle.scheduleIdleExit());
  };
}

/** Agents the vendor was running when its process went with them (the worker is closing it for a newer build, an idle exit or a
 * stop): each is told to the next worker as a durable notification of its own -- its id, task, last saved transcript and, where
 * Claude kept its history, the instruction to resume that agent with SendMessage instead of starting it over. Awaited, so it is
 * on disk before the worker exits. Returns how many were recorded. */
export async function recordInterruptedAgents(ctx: WorkerContext, agents: readonly RunningWork[]): Promise<number> {
  const running = agents.filter((work) => work.kind === 'agent');
  if (!running.length) return 0;
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((entry) => entry.id === ctx.sessionId);
  const account = state.accounts.find((entry) => entry.id === session?.accountId);
  const ended: EndedWork[] = [];
  const native = new Set<string>();
  for (const work of running) {
    const file = session ? await locateAgentTranscript(work, session, account).catch(() => undefined) : undefined;
    if (file) native.add(work.id);
    ended.push({ ...work, outcome: 'cut-off', tail: 'ClikCode closed the process running it before it finished.', ...(file ? { outputFile: file } : {}) });
  }
  lifecycle('worker.agents.interrupted', { count: ended.length, resumable: native.size, agents: ended.map((work) => work.id).join(',') });
  await ctx.io.recordNotificationText(formatEndedWork(ended, native), true);
  return ended.length;
}
