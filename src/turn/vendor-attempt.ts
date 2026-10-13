/** One attempt of a vendor turn: provision the harness, then run it on its transport. */
import { harnessCommand } from '../session/state/paths.js';
import { provisionChosenHarness } from '../harness/provision.js';
import { builtClikcodeLauncher, conversationsForAcpSession, conversationsMcpEntry } from '../search/mcp-entry.js';
import { stateDirectory } from '../session/store/paths.js';
import { adoptListedNativeId } from '../session/discovery/cli-listing.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { closePersistentTransport } from './vendor-process.js';
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

/** Before an attempt spawns the vendor. A server, skill, or same-format
 * hook that is already in the harness is left as it is. A new MCP server
 * is invisible to a process that is already running, so that process is
 * closed and this attempt starts one that can see it. */
async function prepareAttempt(ctx: VendorTurnContext) {
  const { harness, session } = ctx;
  const conversations = conversationsMcpEntry();
  const launcher = builtClikcodeLauncher();
  const provisioningAt = Date.now();
  const provisioned = await provisionChosenHarness({
    ...(launcher ? { launcher } : {}),
    harness, account: ctx.account, workspace: session.workspace, stateDir: stateDirectory(), signIn: ctx.checkMcpSignIn,
    builtins: conversations ? [conversations] : [],
  });
  lifecycle('turn.provisioned', { harness: harness.command, ms: Date.now() - provisioningAt, account: ctx.account.id.slice(0, 8) });
  // A server taken back out is just as invisible to a running process,
  // which would go on asking for its sign-in.
  if (provisioned.mcpInstalled.length || provisioned.mcpRemoved.length) await closePersistentTransport(session.id);
  // Which conversation this is, for ClikCode's conversation MCP server the
  // vendor starts (search/mcp.ts): it leaves this one out of its answers.
  const environment = { ...turnEnvironment(harness, ctx.account, session.permissionMode ?? 'ask'), CLIKCODE_SESSION_ID: session.id };
  // A provider with no signed-in account is signed in to when it is used
  // -- here, as its turn starts -- never when it is merely chosen (opening
  // ClikCode picks one without asking anything).
  if (ctx.account.status === 'needs_login' && !ctx.attempt.authRetried && !await signInForTurn(ctx, environment)) {
    throw new Error(`${harness.displayName} is not signed in. Run \`${harnessCommand()} accounts login ${harness.command}\`.`);
  }
  // A vendor whose config could not take the conversation server gets it
  // with its ACP session instead (a CLI turn has no such channel).
  const sessionMcpServers = conversationsForAcpSession(conversations, provisioned.mcpSkipped,
    { CLIKCODE_SESSION_ID: session.id, ...(process.env.CLIKCODE_HOME ? { CLIKCODE_HOME: process.env.CLIKCODE_HOME } : {}) });
  // Goose resumes by its own id what was created under ClikCode's name.
  if (await adoptListedNativeId(harness, session, environment)) await ctx.checkpoint.persistNow();
  const transport = sessionTurnTransport(harness, session);
  return { environment, sessionMcpServers, transport, provisioning: { launcher, conversations } };
}

/** Runs one attempt; a stopped or oversized one throws, any other failure is
 * recorded for the recovery to decide on. */
export async function runAttempt(ctx: VendorTurnContext, observer: VendorObserver): Promise<AttemptRecord> {
  const { harness, session, checkpoint } = ctx;
  const { environment, sessionMcpServers, transport, provisioning } = await prepareAttempt(ctx);
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
  const runStructuredCliTurn = (): Promise<NativeTurnResult> => runVendorCliAttempt({
    harness, session, turnText: `${ctx.turnText}${ctx.cliImageNote}`, model: ctx.model, environment,
    images: ctx.cliCarriesImages ? ctx.images : [], signal: ctx.signal, run: ctx.run, checkpoint,
    effort: turnEffort(ctx), sharedObserver: observer.sharedObserver,
    onOutputStart: () => { cliOutputStarted = true; },
    onStreamError: (error) => { streamError = error; },
  });
  await openFailoverStandby(ctx, transport, provisioning);
  try {
    if (transport === 'structured-cli' || transport === 'text-cli') {
      result = await runStructuredCliTurn();
    } else {
      result = await runVendorSessionAttempt({
        harness, account: ctx.account, session, transport, turnText: ctx.turnText, model: ctx.model, environment,
        images: ctx.images, signal: ctx.signal, run: ctx.run, checkpoint,
        sharedObserver: observer.sharedObserver, effort: turnEffort(ctx), onSessionId: observer.onSessionId, mcpServers: sessionMcpServers,
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
