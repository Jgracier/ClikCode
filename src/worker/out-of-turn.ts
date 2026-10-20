/** What the vendor says with no turn open (harness/transport/background-turn.ts OutOfTurnRelay):
 * streamed to every attached window as it arrives, and kept in the conversation once said. */
import { outOfTurnRecorder } from '../turn/out-of-turn-record.js';
import { classifyAccountFailure } from '../turn/failover.js';
import { recordQuotaRefusal } from '../turn/account-outcome.js';
import { closePersistentTransport } from '../turn/vendor-process.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { OutOfTurnRelay } from '../harness/transport/background-turn.js';
import type { WorkerContext } from './worker-context.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';

/** A spent-limit sentence ("You've hit your session limit · resets 11:40am"), the whole of what was said. */
export function isLimitRefusal(text: string): boolean {
  const said = text.trim();
  return said.length > 0 && said.length < 300 && !said.includes('\n') && /\blimit\b/i.test(said) && classifyAccountFailure(new Error(said)) === 'quota-exhausted';
}

/** Quiet this long after the last chunk and the message is over: it is saved, and the windows'
 * live view of it ends. The vendor sends no end-of-message for text said outside a turn. */
export const OUT_OF_TURN_SETTLE_MS = Number(process.env.CLIKCODE_OUT_OF_TURN_SETTLE_MS) > 0 ? Number(process.env.CLIKCODE_OUT_OF_TURN_SETTLE_MS) : 1_500;

export interface OutOfTurn {
  relay: OutOfTurnRelay;
  /** Something said is on screen or still being saved: settle() has work to do. */
  readonly active: boolean;
  /** Save what is being said now and end its live view: before a turn takes the windows, or the worker goes. */
  settle(): Promise<void>;
}

/** What the vendor says with no turn open streams to every window as it arrives: shown as a live
 * turn (the windows already draw those from deltas, with no disk round trip), saved once when it
 * goes quiet. It was saved per chunk -- the whole conversation read and written again for every few
 * words, and each window then re-read it to show them -- so on a 21 MB conversation the words came
 * one chunk every 1-4 s behind the vendor (measured 2026-10-19). */
export function createOutOfTurnRelay(ctx: WorkerContext): OutOfTurn {
  const record = outOfTurnRecorder(ctx.sessionId);
  /** The message being said, the generation of the live view showing it, and its save timer. */
  let open: { kind: 'message' | 'thought'; text: string; generation: number; thoughtId: string } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let saving: Promise<void> = Promise.resolve();
  let pending = 0;
  let thoughts = 0;

  const close = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const said = open;
    open = undefined;
    if (!said) return saving;
    pending += 1;
    saving = saving.then(async () => {
      if (said.text) await record({ kind: said.kind, text: said.text, mode: 'replace' });
      // Ended only while it is still what the windows show: a turn may have taken them since.
      if (ctx.observer.turnGeneration !== said.generation) return;
      const { session, account } = await ctx.io.currentSessionAndAccount();
      if (ctx.observer.turnGeneration === said.generation) ctx.observer.endTurn(session, account);
    }).catch(() => undefined).finally(() => { pending -= 1; ctx.idle.scheduleIdleExit(); });
    return saving;
  };

  const relay: OutOfTurnRelay = (said) => {
    // A vendor process still alive on an account that ran out answers on its own with the refusal. That is the
    // account being spent, not something the model said: it is marked so the next turn moves on, the old process
    // is closed so it says nothing more, and the sentence is not written into the conversation.
    if (said.kind === 'message' && isLimitRefusal(said.text)) {
      void (async () => {
        const state = await readState({ transcripts: [] });
        const session = state.sessions.find((item) => item.id === ctx.sessionId);
        const account = session?.nativeThreadAccountId ? state.accounts.find((item) => item.id === session.nativeThreadAccountId) : undefined;
        if (account) { recordQuotaRefusal(state, account, new Error(said.text)); await writeState(state); }
        await closePersistentTransport(ctx.sessionId);
      })().catch(() => undefined);
      return;
    }
    // A thought after words, or words after a thought: the one said so far is a message of its own.
    if (open && open.kind !== said.kind) void close();
    if (!open) {
      ctx.observer.startTurn(said.kind === 'thought' ? 'thinking' : 'writing', undefined, true);
      open = { kind: said.kind, text: '', generation: ctx.observer.turnGeneration, thoughtId: `out-of-turn-thought-${++thoughts}` };
    }
    open.text = said.mode === 'replace' ? said.text : open.text + said.text;
    if (said.kind === 'message') ctx.observer.response(said.text, said.mode);
    else ctx.observer.activityEvent({ kind: 'thinking', label: thoughtLabel(open.text), id: open.thoughtId });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void close(); }, OUT_OF_TURN_SETTLE_MS);
    timer.unref();
  };

  return { relay, get active() { return Boolean(open) || pending > 0; }, settle: close };
}
