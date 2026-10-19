/** What the vendor says with no turn open (harness/transport/background-turn.ts
 * OutOfTurnRelay): appended to the conversation, then told to every attached
 * window -- the transcript through a snapshot, the words as an event. Nothing
 * here runs, so nothing is shown as working. */
import { outOfTurnRecorder } from '../turn/out-of-turn-record.js';
import { classifyAccountFailure } from '../turn/failover.js';
import { recordQuotaRefusal } from '../turn/account-outcome.js';
import { closePersistentTransport } from '../turn/vendor-process.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { OutOfTurnRelay } from '../harness/transport/background-turn.js';
import type { WorkerContext } from './worker-context.js';

/** A spent-limit sentence ("You've hit your session limit · resets 11:40am"), the whole of what was said. */
export function isLimitRefusal(text: string): boolean {
  const said = text.trim();
  return said.length > 0 && said.length < 300 && !said.includes('\n') && /\blimit\b/i.test(said) && classifyAccountFailure(new Error(said)) === 'quota-exhausted';
}

export function createOutOfTurnRelay(ctx: WorkerContext): OutOfTurnRelay {
  const record = outOfTurnRecorder(ctx.sessionId);
  return (said) => {
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
    void record(said).then(async () => {
      const { session, account } = await ctx.io.currentSessionAndAccount();
      ctx.observer.render(session, account);
      ctx.observer.broadcast({ type: 'out-of-turn', kind: said.kind, text: said.text, mode: said.mode });
    }).catch(() => undefined);
  };
}
