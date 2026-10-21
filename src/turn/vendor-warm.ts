/** A chat that just moved to this machine, got ready for its first turn
 * before it is sent -- the way a failover's standby is opened for an account
 * switch (vendor-standby.ts), with no model call and no usage:
 *
 *  - the conversation taken up by the vendor now (vendor-thread-takeup.ts):
 *    written as its own thread where the harness has a writer, so the first
 *    turn resumes it instead of writing it;
 *  - the conversation's vendor child started and the thread loaded, up to
 *    the prompt (prepareVendorAhead): the first turn takes that child.
 *
 * Only what the first turn would do anyway, on the account and settings it
 * would use: anything this machine cannot run yet (no account signed in, the
 * vendor not installed, a one-process-per-turn CLI) is left for the turn,
 * which says so as for any new chat here. */
import { homedir } from 'node:os';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { nativeSessionStore } from '../session/discovery/registry.js';
import { harnessCanRunTurns, localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { inspectNativeHarness } from '../harness/transport/native/inspect.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { turnBackendForAccount } from './account-routing.js';
import { turnEnvironment } from './turn-environment.js';
import { takeUp } from './vendor-thread-takeup.js';
import { prepareVendorAhead } from './vendor-session-attempt.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

/** What the take-up records of the vendor's thread, written back as it is. */
const THREAD_FIELDS = ['nativeSessionId', 'nativeThreadAccountId', 'nativeSessionPreallocated', 'nativeTransport'] as const;

/** Warms `sessionId`'s vendor. True when a vendor child was opened. */
export async function warmVendor(sessionId: string): Promise<boolean> {
  const startedAt = Date.now();
  const state = await readState({ transcripts: [sessionId] });
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || session.movedTo || session.pendingTurn || session.route !== 'local' || !session.nativeHarness) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (!harness || !harnessCanRunTurns(harness) || !account || account.provider !== harness.provider) return false;
  if (account.status !== 'ready' || turnBackendForAccount(account) !== 'vendor') return false;
  if (!(await inspectNativeHarness(harness).catch(() => undefined))?.installed) return false;
  session.workspace ??= homedir();
  // The conversation, written as the vendor's own thread now rather than by
  // the first turn. A harness with no writer is retold by that turn instead.
  if ((!session.nativeSessionId || session.nativeSessionPreallocated) && sessionTranscriptMessages(session).length && nativeSessionStore(harness)?.writer) {
    const persistNow = async (): Promise<void> => {
      const latest = await readState({ transcripts: [] });
      const target = latest.sessions.find((item) => item.id === sessionId);
      if (!target) return;
      for (const field of THREAD_FIELDS) {
        if (session[field] === undefined) delete target[field];
        else (target as unknown as Record<string, unknown>)[field] = session[field];
      }
      await writeState(latest);
    };
    const ctx = { state, session, harness, account, model: session.model, checkpoint: { persistNow } } as unknown as VendorTurnContext;
    await takeUp(ctx, '', { interrupted: false, withJournal: false });
  }
  const transport = sessionTurnTransport(harness, session);
  if (transport !== 'acp' && transport !== 'codex-app-server') return false;
  const environment = turnEnvironment(harness, account, session.permissionMode ?? 'ask');
  await prepareVendorAhead({ harness, account, session: session as HarnessSession, transport, model: session.model, ...(session.effort ? { effort: session.effort } : {}), environment });
  lifecycle('worker.warm', { harness: harness.command, transport, thread: Boolean(session.nativeSessionId), ms: Date.now() - startedAt });
  return true;
}
