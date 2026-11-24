/** Taking a conversation up on a harness's fresh thread, and the edits a retry
 * makes to the answer written so far. */
import { recordReachFor, writeFullRecord } from '../session/full-record.js';
import { reachesBuiltInMcp } from '../harness/transport/acp-mcp-servers.js';
import { stateDirectory } from '../session/store/paths.js';
import { carriedLine, startConversationThread } from './thread-start.js';
import { DEFAULT_COMPACT_AT_TOKENS } from './compaction.js';
import { contextThreshold } from './context-tune.js';
import { vendorDefaultTrigger } from './context-shadow.js';
import { knownVendorMeasures } from './vendor-floors.js';
import { targetContextWindow } from './transfer.js';
import { canonicalRecord } from '../session/canonical.js';
import { nativeSessionStore } from '../session/discovery/registry.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { inspectNativeHarness } from '../harness/transport/native/inspect.js';
import { maxPromptArgvBytes, localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { turnEnvironment } from './turn-environment.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

const RETRY_EDITS = { clear: ['', 'replace'], 'new-paragraph': ['\n\n', 'append'] } as const;
type RetryEdit = keyof typeof RETRY_EDITS;

/** The two edits a retry makes to the answer, in the saved turn and on
 * screen alike: clear it, or start a new paragraph after it. Only these --
 * the model's own words reach the screen through emitResponseDelta alone. */
export function editAnswer(ctx: VendorTurnContext, edit: RetryEdit): void {
  ctx.checkpoint.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
  ctx.prompter?.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
}

/** A retry's answer: cleared, or continued in a new paragraph unless it
 * already ends in one. */
export function continueAnswer(ctx: VendorTurnContext, edit: RetryEdit): void {
  if (edit === 'clear' || !/\n\s*\n\s*$/.test(ctx.session.pendingTurn?.response ?? '')) editAnswer(ctx, edit);
}

/** The conversation, taken up by this harness without a live thread of its
 * own (thread-start.ts): written as its native thread where a writer for it
 * exists, else retold as a transfer. Returns what to send. `interrupted`:
 * the request continues the newest turn, whose journal (`withJournal`) or
 * copy holds the answer so far; `requestContext` is what that turn's
 * request carried besides its words (attached files), which the journal
 * does not keep. */
export async function takeUp(
  ctx: VendorTurnContext, request: string, options: { interrupted: boolean; withJournal: boolean; requestContext?: string; reportCarry?: boolean },
): Promise<string> {
  const { session, harness, state, checkpoint } = ctx;
  const view = options.withJournal ? session : { ...session, pendingTurn: undefined };
  const record = canonicalRecord(view);
  const last = record.turns.at(-1);
  if (options.interrupted && options.requestContext && last) last.user = `${last.user}${options.requestContext}`;
  const transport = sessionTurnTransport(harness, session);
  const argvBound = (transport === 'structured-cli' || transport === 'text-cli') && harness.turn?.promptInput !== 'stdin';
  const contextWindow = await targetContextWindow(state.sessions, harness.command, ctx.model, modelsDevFiles()).catch(quiet('turn/vendor-thread-takeup'));
  const writer = nativeSessionStore(harness)?.writer;
  // The whole conversation is always kept in a file, and the receiving provider
  // is told where to reach it (its hindsight tool, or that file), so whatever
  // its window cannot hold is still within reach. A summary any provider made
  // of it is never put in place of turns: a handoff carries the conversation itself.
  const recordPath = record.turns.length ? await writeFullRecord(view, stateDirectory()) : undefined;
  const recordReach = record.turns.length ? recordReachFor(reachesBuiltInMcp(harness, transport), recordPath) : undefined;
  // Never more than the compaction threshold; a compaction ClikCode does itself (no native one,
  // compaction-run.ts compactByRewrite) fits it to half of that, so it is not due again at once.
  const known = knownVendorMeasures(harness.command, ctx.model);
  const threshold = contextThreshold(state.globalSettings, harness.command, ctx.model, { ...(known.floor !== undefined ? { floor: known.floor } : {}), ...(contextWindow ? { window: contextWindow } : {}) })
    ?? vendorDefaultTrigger(contextWindow, harness.compactThreshold?.unit === 'claude-window') ?? DEFAULT_COMPACT_AT_TOKENS;
  const rewrite = Boolean(session.compaction?.rewrite);
  const capTokens = rewrite ? Math.floor(threshold / 2) : threshold;
  const start = await startConversationThread({
    record, request, interrupted: options.interrupted, harness, model: ctx.model,
    session,
    ...(recordReach ? { recordReach } : {}),
    workspace: session.workspace ?? process.cwd(), environment: turnEnvironment(harness, ctx.account),
    ...(contextWindow ? { contextWindow } : {}), ...(argvBound ? { argvLimit: maxPromptArgvBytes() } : {}), capTokens,
    ...(writer ? { writer } : {}),
    version: async () => (await inspectNativeHarness(harness)).version,
    displayName: (command) => localHarnessForCommand(command)?.displayName,
    onFallback: (reason) => lifecycle('thread.writer-fallback', { harness: harness.command, reason }),
  });
  lifecycle('thread.take-up', {
    harness: harness.command, how: start.kind, turns: record.turns.length, interrupted: options.interrupted,
    ...(recordPath ? { record: recordPath } : {}),
    ...(start.kind === 'transfer' ? { budget: start.budget, bytes: Buffer.byteLength(start.prompt, 'utf8'), contextWindow } : { omitted: start.omitted, contextWindow }),
  });
  // A conversation that did not arrive whole was compacted, and the chat says so (a compaction
  // ClikCode ran itself already did).
  const carried = carriedLine(record.turns.length, start);
  // What the fresh thread holds only fitted, or not at all, is what recall searches (search/recall.ts).
  if (carried) session.recallFrom = session.messages?.length ?? 0;
  else delete session.recallFrom;
  if (carried && options.reportCarry !== false && !rewrite) ctx.prompter?.activity(carried);
  if (rewrite) delete session.compaction!.rewrite;
  if (start.kind === 'native') {
    session.nativeSessionId = start.written.nativeId;
    session.nativeThreadAccountId = ctx.account.id;
    delete session.nativeSessionPreallocated;
    if (start.written.transport) session.nativeTransport = start.written.transport;
    else delete session.nativeTransport;
    await checkpoint.persistNow();
  }
  return start.prompt;
}

/** A retry on a fresh thread (the old one already forgotten). The request is
 * always the user's own. A turn that already wrote (`wrote`) is taken up with
 * the answer so far in the carried conversation, marked cut off; one that
 * produced nothing is taken up as the request alone. The answer is cleared,
 * or continued in a new paragraph. Returns what to send. */
export async function retell(ctx: VendorTurnContext, request: string, edit: RetryEdit, wrote: boolean): Promise<string> {
  // Retries on another account already produce one plain account-switch line.
  // Repeating a second full "Carried N turns" activity on every failed account
  // made one switch sequence look like many provider handoffs.
  const prompt = await takeUp(ctx, request, { interrupted: wrote, withJournal: wrote, requestContext: ctx.requestContext, reportCarry: false });
  continueAnswer(ctx, edit);
  return prompt;
}
