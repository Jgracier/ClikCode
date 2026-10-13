/** What the vendor says with no turn open (harness/transport/background-turn.ts
 * OutOfTurnRelay): appended to the conversation, then told to every attached
 * window -- the transcript through a snapshot, the words as an event. Nothing
 * here runs, so nothing is shown as working. */
import { outOfTurnRecorder } from '../turn/out-of-turn-record.js';
import type { OutOfTurnRelay } from '../harness/transport/background-turn.js';
import type { WorkerContext } from './worker-context.js';

export function createOutOfTurnRelay(ctx: WorkerContext): OutOfTurnRelay {
  const record = outOfTurnRecorder(ctx.sessionId);
  return (said) => {
    void record(said).then(async () => {
      const { session, account } = await ctx.io.currentSessionAndAccount();
      ctx.observer.render(session, account);
      ctx.observer.broadcast({ type: 'out-of-turn', kind: said.kind, text: said.text, mode: said.mode });
    }).catch(() => undefined);
  };
}
