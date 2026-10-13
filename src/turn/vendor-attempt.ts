/** One attempt of a vendor turn: run it on its transport. */
import { harnessCommand } from '../session/state/paths.js';
import { adoptListedNativeId } from '../session/discovery/cli-listing.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { turnEnvironment } from './turn-environment.js';
import { runVendorCliAttempt } from './vendor-cli-attempt.js';
import { runVendorSessionAttempt } from './vendor-session-attempt.js';
import { signInForTurn } from './vendor-sign-in.js';
import { openFailoverStandby } from './vendor-standby.js';
import type { VendorObserver, VendorTransport } from './vendor-observer.js';
import { turnEffort, type VendorTurnContext } from './vendor-turn-context.js';

/** What an attempt did, for the recovery or the completion that follows it. */
export interface AttemptRecord {
  /** The error the transport threw, when it threw. */
  caughtTurnFailure: Error | undefined;
  result: NativeTurnResult;
  streamError: { message: string; statusCode?: number; kind?: string } | undefined;
  cliOutputStarted: boolean;
  /** Where this attempt's text begins, and whether an earlier attempt had
   * already written: a refusal the vendor streams as text is no answer. */
  responseBefore: number;
  wroteBefore: boolean;
  environment: Readonly<Record<string, string>>;
  transport: VendorTransport;
}

/** Before an attempt spawns the vendor. The vendor's own configuration, MCP
 * servers, skills and hooks are the vendor's: nothing is written into them. */
async function prepareAttempt(ctx: VendorTurnContext) {
  const { harness, session } = ctx;
  const environment = turnEnvironment(harness, ctx.account, session.permissionMode ?? 'ask');
  // A provider with no signed-in account is signed in to when it is used
  // -- here, as its turn starts -- never when it is merely chosen (opening
  // ClikCode picks one without asking anything).
  if (ctx.account.status === 'needs_login' && !ctx.attempt.authRetried && !await signInForTurn(ctx, environment)) {
    throw new Error(`${harness.displayName} is not signed in. Run \`${harnessCommand()} accounts login ${harness.command}\`.`);
  }
  // Goose resumes by its own id what was created under ClikCode's name.
  if (await adoptListedNativeId(harness, session, environment)) await ctx.checkpoint.persistNow();
  const transport = sessionTurnTransport(harness, session);
  return { environment, transport };
}

/** Runs one attempt; a stopped or oversized one throws, any other failure is
 * recorded for the recovery to decide on. */
export async function runAttempt(ctx: VendorTurnContext, observer: VendorObserver): Promise<AttemptRecord> {
  const { harness, session, checkpoint } = ctx;
  const { environment, transport } = await prepareAttempt(ctx);
  observer.beginAttempt(transport);
  // A fresh native thread with prior ClikCode messages: see above. Also
  // covers an id ClikCode minted that the vendor never confirmed.
  let caughtTurnFailure: Error | undefined;
  let result: NativeTurnResult | undefined;
  let streamError: AttemptRecord['streamError'];
  let cliOutputStarted = false;
  const responseBefore = session.pendingTurn?.response?.length ?? 0;
  const wroteBefore = Boolean(session.pendingTurn?.outputStarted);
  observer.resetAttempt();
  const runStructuredCliTurn = async (): Promise<NativeTurnResult> => {
    if (ctx.images.length && !ctx.cliCarriesImages) {
      throw new Error(`Image attachments are not available for ${harness.displayName} over its CLI. Clear them with /attachments clear.`);
    }
    return runVendorCliAttempt({
      harness, session, turnText: ctx.turnText, model: ctx.model, environment,
      images: ctx.images, signal: ctx.signal, run: ctx.run, checkpoint,
      effort: turnEffort(ctx), sharedObserver: observer.sharedObserver,
      onOutputStart: () => { cliOutputStarted = true; },
      onStreamError: (error) => { streamError = error; },
    });
  };
  await openFailoverStandby(ctx, transport);
  try {
    if (transport === 'structured-cli' || transport === 'text-cli') {
      result = await runStructuredCliTurn();
    } else {
      result = await runVendorSessionAttempt({
        harness, account: ctx.account, session, transport, turnText: ctx.turnText, model: ctx.model, environment,
        images: ctx.images, signal: ctx.signal, run: ctx.run, checkpoint,
        sharedObserver: observer.sharedObserver, effort: turnEffort(ctx), onSessionId: observer.onSessionId,
        runCli: runStructuredCliTurn,
      });
    }
  } catch (error) {
    if (isTurnCancelled(error)) { observer.recordUnfinishedAttempt('stopped'); throw error; }
    if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_TOO_LARGE') { observer.recordUnfinishedAttempt('error'); throw error; }
    caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
  }
  return {
    caughtTurnFailure,
    result: caughtTurnFailure ? { isError: true, text: caughtTurnFailure.message } : result!,
    streamError, cliOutputStarted, responseBefore, wroteBefore, environment, transport,
  };
}
