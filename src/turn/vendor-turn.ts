/** Run a turn through a vendor's CLI or structured session protocol. */
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { harnessCommand } from '../session/state/paths.js';
import chalk from 'chalk';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { createPendingWorkTracker } from './pending-work.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
import { turnAccounts, turnBackendForAccount } from './account-routing.js';
import { classifyAccountFailure } from './failover.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { keepsNoHistory, startConversationThread } from './thread-start.js';
import { targetContextWindow } from './transfer.js';
import { canonicalRecord } from '../session/canonical.js';
import { nativeSessionStore } from '../session/discovery/registry.js';
import { adoptListedNativeId } from '../session/discovery/cli-listing.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { inspectNativeHarness } from '../harness/transport/native/inspect.js';
import { maxPromptArgvBytes } from '../runtime/lazy-bridge.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { moveThreadToAccount } from '../session/carry.js';
import { sessionTitleSource, prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { nativeGeneratedTitle } from '../session/discovery/titles.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { nativeTurnFailure, type NativeTurnResult } from '../harness/protocol/turn-result.js';
import { withWorkspacePaths } from '../harness/protocol/activity-view.js';
import { harnessSupportsImages, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { writeState } from '../session/state/write.js';
import { syncAccountIdentityAfterLogin, withSignIn } from '../commands/account.js';
import { ensureTurboFitForTurn } from '../commands/ai/turbofit.js';
import { closePersistentTransport, rememberFallbackTurn, usesFallbackTurn, nativeAvailableCommands } from './vendor-process.js';
import { completeTurnCheckpoint, startTurnCheckpoint } from './turn-journal.js';
import { turnEnvironment } from './turn-environment.js';
import type { TurnRunOptions } from './session-turn.js';
import { runVendorCliAttempt } from './vendor-cli-attempt.js';
import { runVendorSessionAttempt } from './vendor-session-attempt.js';
import { emitHarnessOutput } from '../harness/output.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { harnessCanRunTurns, harnessLoginArgvForModel, harnessReplyError, modelProvider } from '../runtime/lazy-bridge.js';
import { prepareAttachments } from '../session/attachments.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { forgetNativeThread } from '../session/native-thread.js';
import { provisionChosenHarness } from '../harness/provision.js';
import { builtClikcodeLauncher, conversationsForAcpSession, conversationsMcpEntry } from '../search/mcp-entry.js';
import { stateDirectory } from '../session/store/paths.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { recordInvocation, showStopReason, turnSink } from './turn-output.js';
import { swarmIsOn } from '../swarm/policy.js';
import { swarmProvisionEntry, swarmRidesTurn } from '../swarm/publish.js';
import { openSwarmTurn } from '../swarm/store.js';
import { emptySwarmFold, foldSwarmActivity, type SwarmFold } from '../swarm/fold.js';
import { watchSwarmActivity } from '../swarm/spool.js';

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
/** A vendor refusing the reasoning level itself, in the words the CLIs use. */
const EFFORT_REJECTED = /\b(?:unknown|invalid|unsupported|not supported)\b[^\n]{0,40}\b(?:reasoning[ _-]?)?effort\b|\beffort\b[^\n]{0,40}\b(?:is not supported|not supported|unsupported|invalid)\b/i;

/** Whether a failed turn is the vendor refusing the reasoning level: an ACP
 * session that offers no such level (acp-client.ts), or a CLI saying so in
 * its message or stderr -- never read from a model's reply. */
export function isEffortRefusal(failure: Error): boolean {
  if ((failure as { acpUnsupportedEffort?: unknown }).acpUnsupportedEffort === true) return true;
  const stderr = (failure as { stderrTail?: unknown }).stderrTail;
  return EFFORT_REJECTED.test([failure.message, typeof stderr === 'string' ? stderr : ''].join('\n'));
}

const RETRY_EDITS = { clear: ['', 'replace'], 'new-paragraph': ['\n\n', 'append'] } as const;

/** Sessions whose current vendor process was opened with the swarm tool. */
const swarmAttached = new Set<string>();

export async function sendVendorTurn(input: {
  state: HarnessState;
  session: HarnessSession;
  account: AiHarnessAccount;
  model: string | null;
  text: string;
  prepared: Awaited<ReturnType<typeof prepareAttachments>>;
  turnText: string;
  startedAt: number;
  signal?: AbortSignal;
  run: TurnRunOptions;
}): Promise<void> {
  const { state, session, text, prepared, startedAt, signal, run } = input;
  let { account, model, turnText } = input;
  const prompter = run.prompter;
  const harness = session.nativeHarness
    ? localHarnessForCommand(session.nativeHarness)
    : localHarnessForProvider(account.provider);
  if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
  if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
  if (harness.provider !== account.provider) throw new Error(`session provider ${harness.displayName} does not match account "${account.label}"`);
  // Installed before anything spawns it: model discovery below, then
  // whichever transport runs the turn -- the app-server and ACP ones too,
  // which spawn the binary themselves. A chat whose harness this machine
  // does not have (chosen elsewhere, or uninstalled since) installs it here
  // instead of failing "not found".
  await ensureNativeHarness(harness, prompter ? {
    reporter: {
      start: (label) => prompter.phase(label),
      done: (message) => prompter.activity(chalk.dim(message)),
      failed: () => undefined,
    },
  } : {});
  // Resolve a real model here too, not only when a session is OPENED.
  // A headless send -- `sessions send`, and every member of a fan-out --
  // never goes through the interactive open path, so it recorded no model
  // at all: the invocation landed with the field absent and usage could
  // not be attributed to anything. Cheap to call (the catalog is cached,
  // and an ACP session keeps it current) and persisted, so the next turn
  // on this session finds it already there.
  if (!model) {
    model = await resolveNativeModel(harness, account) ?? null;
    if (model) session.model = model;
  }
  // A TurboFit local model is running before its turn (a headless send, a
  // worker picking up a session whose terminal took the lease).
  model = await ensureTurboFitForTurn(harness, account, session.id, model);
  if (model) session.model = model;
  // An unnamed chat gets a title from the harness that writes one, and asks
  // the model for one where the harness does not. The request rides on this
  // turn's text only -- never on what is stored as the user's message -- and
  // the answer is stripped of it before anyone sees it.
  const titleSource = sessionTitleSource(harness);
  const titleRequest = titleSource === 'ask' ? prepareSessionTitle(session, turnText) : undefined;
  let titleStream = titleRequest?.stream;
  if (titleRequest) turnText = titleRequest.prompt;
  const supportsImages = harnessSupportsImages(harness);
  const images = supportsImages ? prepared.images : [];
  const imageNote = prepared.images.length && !supportsImages
    ? `\n\nImage files available in the workspace:\n${prepared.images.map((path) => `- ${path}`).join('\n')}`
    : '';
  turnText += imageNote;
  /** What the request carried besides its words. A retry on a fresh thread
   * retells the conversation from ClikCode's copy, which holds only what was
   * typed -- without this the attached files were silently gone from it. (`!`
   * output needs nothing: it is its own message in that copy.) */
  const requestContext = `${prepared.textContext}${imageNote}`;
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.workspace ??= process.cwd();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  /** The two edits a retry makes to the answer, in the saved turn and on
   * screen alike: clear it, or start a new paragraph after it. Only these --
   * the model's own words reach the screen through emitResponseDelta alone. */
  const editAnswer = (edit: keyof typeof RETRY_EDITS): void => {
    checkpoint.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
    prompter?.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
  };
  /** The conversation, taken up by this harness without a live thread of its
   * own (thread-start.ts): written as its native thread where a writer for it
   * exists, else retold as a transfer. Returns what to send. `interrupted`:
   * the request continues the newest turn, whose journal (`withJournal`) or
   * copy holds the answer so far; `requestContext` is what that turn's
   * request carried besides its words (attached files), which the journal
   * does not keep. */
  const takeUp = async (request: string, options: { interrupted: boolean; withJournal: boolean; requestContext?: string }): Promise<string> => {
    const view = options.withJournal ? session : { ...session, pendingTurn: undefined };
    const record = canonicalRecord(view);
    const last = record.turns.at(-1);
    if (options.interrupted && options.requestContext && last) last.user = `${last.user}${options.requestContext}`;
    const transport = sessionTurnTransport(harness, session);
    const argvBound = (transport === 'structured-cli' || transport === 'text-cli') && harness.turn?.promptInput !== 'stdin';
    const contextWindow = await targetContextWindow(state.sessions, harness.command, model, modelsDevFiles()).catch(() => undefined);
    const writer = nativeSessionStore(harness)?.writer;
    const start = await startConversationThread({
      record, request, interrupted: options.interrupted, harness, model,
      workspace: session.workspace ?? process.cwd(), environment: turnEnvironment(harness, account),
      ...(contextWindow ? { contextWindow } : {}), ...(argvBound ? { argvLimit: maxPromptArgvBytes() } : {}),
      ...(writer ? { writer } : {}),
      version: async () => (await inspectNativeHarness(harness)).version,
      displayName: (command) => localHarnessForCommand(command)?.displayName,
      onFallback: (reason) => lifecycle('thread.writer-fallback', { harness: harness.command, reason }),
    });
    lifecycle('thread.take-up', {
      harness: harness.command, how: start.kind, turns: record.turns.length, interrupted: options.interrupted,
      ...(start.kind === 'transfer' ? { budget: start.budget, bytes: Buffer.byteLength(start.prompt, 'utf8'), contextWindow } : { omitted: start.omitted, contextWindow }),
    });
    if (start.kind === 'native') {
      session.nativeSessionId = start.written.nativeId;
      delete session.nativeSessionPreallocated;
      if (start.written.transport) session.nativeTransport = start.written.transport;
      else delete session.nativeTransport;
      await checkpoint.persistNow();
    }
    return start.prompt;
  };
  /** A retry on a fresh thread (the old one already forgotten). A turn that
   * already wrote is taken up with the answer so far and the continuation.
   * One that produced nothing is taken up as the request itself. The answer
   * is cleared, or continued in a new paragraph. Returns what to send. */
  const retell = async (request: string, edit: keyof typeof RETRY_EDITS): Promise<string> => {
    const continuing = request === INTERRUPTED_TURN_REQUEST;
    const prompt = await takeUp(request, { interrupted: continuing, withJournal: continuing, requestContext });
    continueAnswer(edit);
    return prompt;
  };
  /** A retry's answer: cleared, or continued in a new paragraph unless it
   * already ends in one. */
  const continueAnswer = (edit: keyof typeof RETRY_EDITS): void => {
    if (edit === 'clear' || !/\n\s*\n\s*$/.test(session.pendingTurn?.response ?? '')) editAnswer(edit);
  };
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => turnBackendForAccount(item) === 'vendor',
    persist: () => checkpoint.persistNow(), current: () => account, adopt: (to) => { account = to; },
    beforeSwitch: () => closePersistentTransport(session.id),
  });
  let stopSwarmWatch = (): void => undefined;
  try {
  // The thread goes with the conversation, as on a switch mid-turn; only
  // one that cannot be carried starts afresh.
  if (await accounts.start(async (to) => { await moveThreadToAccount(session, harness, account, to); })) {
    await checkpoint.persistNow();
  }
  // A fresh native thread (no nativeSessionId yet) with prior ClikCode
  // messages already on the session means this conversation is continuing
  // under a different native identity than whatever produced those messages
  // -- a provider switch, a switch back, a fork, "Resume in". The vendor
  // process about to start has no memory of any of it unless it is given
  // it: takeUp writes it as the vendor's own thread, or transfers it. The
  // failover retries below take the same path mid-turn.
  if ((!session.nativeSessionId || session.nativeSessionPreallocated) && baseMessages.length > 0) {
    turnText = await takeUp(turnText, { interrupted: text === INTERRUPTED_TURN_REQUEST, withJournal: false });
  }
  // Bounded to one attempt: this is a reactive fallback for exactly the
  // case aiHarnessSelect's own proactive check can't catch -- a harness
  // with no statusArgv (nothing to scriptably ask "am I logged in?"
  // before the turn even starts), where the *first* real signal is the
  // turn itself failing. Retrying more than once would risk a loop if
  // login genuinely doesn't fix it (wrong account, network issue, etc.).
  let authRetried = false;
  /** Sign in to the account this turn runs on, once per turn: true when it
   * worked and the account is ready. */
  const signInForTurn = async (environment: Readonly<Record<string, string>>): Promise<boolean> => {
    // A multi-provider harness signs in to the provider the model runs on
    // (`hermes auth add opencode-free`), not the whole harness.
    const signInArgv = harnessLoginArgvForModel(harness, model);
    // With no one watching, the sign-in is the plain terminal's (login.ts
    // plainSignInScreen: the link printed, questions read from stdin) -- the
    // console with no alternate screen, a send from a shell. Only with a
    // person at that terminal: a piped send fails as not signed in.
    if (!signInArgv || (!prompter && !process.stdin.isTTY)) return false;
    authRetried = true;
    await closePersistentTransport(session.id);
    const signIn = { ...harness, loginArgv: signInArgv };
    const signInName = signInArgv === harness.loginArgv ? harness.displayName : `${harness.displayName} › ${model ? modelProvider(harness, model) : ''}`;
    // A worker has no terminal: its client runs the sign-in and says when it
    // is done. Without that the vendor's login ran here, in a detached
    // process, and could never finish.
    const signedIn = await (prompter?.signIn
      ? prompter.signIn({ command: harness.command, argv: signInArgv, environment, name: signInName })
      : withSignIn(prompter, signInName, () => loginNativeHarness(signIn, environment)))
      .then(() => true, (error: unknown) => {
        prompter?.activity(chalk.yellow(`sign-in to ${signInName} did not finish: ${error instanceof Error ? error.message : String(error)}`));
        return false;
      });
    if (!signedIn) return false;
    // Said by the turn, as its failure is: a window's own line for it is
    // drawn under a turn that owns the screen, and was lost.
    if (prompter?.signIn) prompter.activity(`${chalk.green('signed in to')} ${chalk.dim(signInName)}`);
    account = await syncAccountIdentityAfterLogin(harness, account, state);
    await accounts.recordAccount(account);
    return true;
  };
  let effortRetried = false;
  /** A fresh native thread gets one recovery attempt per account. */
  let nativeThreadRetried = false;
  const effortKey = (): string => `${harness.command} ${model ?? ''} ${session.effort}`;
  const turnEffort = (): string | undefined => session.effort && session.effortRefused !== effortKey() ? session.effort : undefined;
  /** Shared by every transport: usage seen on the wire for this attempt.
   * Each report is the attempt's running total, so its fields replace. */
  let turnUsage: TurnUsage | undefined;
  const noteUsage = (usage: TurnUsage): void => {
    turnUsage = { ...turnUsage, ...usage };
    const shown = turnUsage!;
    session.lastUsage = { ...shown, at: new Date().toISOString() };
    prompter?.setTurnUsage(shown);
  };
  const pendingWork = createPendingWorkTracker(harness.command);
  /** The response-delta rule, in one place. Every transport owes the same
   * three steps -- through the title filter, then to the checkpoint and to
   * the screen -- and they differed only in which default mode they passed.
   * This was three copies, and drift between them was not hypothetical: the
   * structured-CLI copy once skipped the title filter entirely, which made
   * what was displayed differ from what was persisted, and the transcript
   * then read the saved answer as new content and drew the whole reply a
   * second time. That was the duplicated response. One function cannot
   * drift from itself. */
  const sink = turnSink(checkpoint, prompter, {
    title: () => titleStream,
  });
  let swarmFold: SwarmFold = emptySwarmFold();
  const onActivity = (event: HarnessActivityEvent): void => {
    // The clerk's frames are the row. The host's own swarm tool is the same
    // call: count that tool so a backgrounded command still pairs, and do
    // not count the clerk frames as a second piece of unfinished work.
    const folded = foldSwarmActivity(swarmFold, event);
    swarmFold = folded.fold;
    if (!event.swarm) pendingWork.note(event);
    if (folded.event) sink.activity(withWorkspacePaths(folded.event, session.workspace));
  };
  if (swarmIsOn(session)) {
    await openSwarmTurn(session.id).catch(() => undefined);
    stopSwarmWatch = watchSwarmActivity(session.id, onActivity);
  }
  // The tool rides on the ACP session ClikCode opens. A process already up
  // was opened without it, or still has it after swarm was turned off.
  if (harness.acp && swarmIsOn(session) !== swarmAttached.has(session.id)) {
    await closePersistentTransport(session.id);
    if (swarmIsOn(session)) swarmAttached.add(session.id);
    else swarmAttached.delete(session.id);
  }
  /** A transport's thought is the whole of it so far: one row per id,
   *  replaced as it grows (activity-events.ts thoughtLabel). */
  const onThought = (thought: string, id?: string): void => {
    const label = thoughtLabel(thought);
    if (label) onActivity({ kind: 'thinking', label, ...(id ? { id } : {}) });
  };
  const onSessionId = async (nativeSessionId: string): Promise<void> => {
    if (session.nativeSessionId === nativeSessionId && !session.nativeSessionPreallocated) return;
    session.nativeSessionId = nativeSessionId;
    keepTransport(activeTransport);
    delete session.nativeSessionPreallocated;
    await checkpoint.persistNow();
  };
  /** A vendor thread stays on the transport that created it (select.ts),
   * unless ACP and the CLI share its store and it is tied to neither. */
  const keepTransport = (transport: typeof activeTransport): void => {
    if (harness.acp?.sharedSessions) return;
    if (transport === 'acp' || transport === 'structured-cli' || transport === 'text-cli') session.nativeTransport ??= transport;
  };
  /** The observer members every transport implements identically. Each
   * transport spreads this and then overrides only what genuinely differs
   * for it (codex's rate limits and steering, the structured CLI's own idle
   * bookkeeping) -- so a member absent from a transport's literal is a
   * deliberate default, not a forgotten one. */
  const sharedObserver = {
    onActivity, onThought, onUsage: noteUsage,
    onResponseDelta: sink.response,
    onPhase: (phase: string) => prompter?.phase(phase),
    onNotice: (message: string) => prompter?.activity(chalk.yellow(message)),
    onPlan: (entries: readonly HarnessPlanEntry[]) => {
      // Kept on the session too: a provider taking the conversation over is
      // told the todos still open (session/canonical.ts).
      session.plan = { entries: entries.map((entry) => ({ ...entry })), at: new Date().toISOString() };
      checkpoint.touch();
      prompter?.setPlan(entries);
    },
    // A native harness runs its OWN tools, so ClikCode has no rule to
    // remember on its behalf -- and with no rule offered the prompter never
    // returns 'always' anyway. Collapsed to a boolean here so that boundary
    // is stated rather than implied.
    onApproval: async (title: string, detail?: string, preview?: ApprovalPreview) => (await prompter?.approval(title, detail, preview)) === true,
    onAvailableCommands: (commands: readonly HarnessAvailableCommand[]) => { nativeAvailableCommands.set(session.id, commands); },
  } satisfies HarnessTurnObserver;
  let activeTransport: ReturnType<typeof sessionTurnTransport> | undefined;
  // The request this turn was asked, before a retry replaces it. A failover
  // that produced no output sends this again; rebuilding the transcript
  // would repeat the whole conversation on top of a thread that already has it.
  const askedText = turnText;
  for (;;) {
    // Before this attempt spawns the vendor. A server, skill, or same-format
    // hook that is already in the harness is left as it is. A new MCP server
    // is invisible to a process that is already running, so that process is
    // closed and this attempt starts one that can see it.
    const conversations = conversationsMcpEntry();
    const swarmEntry = swarmProvisionEntry();
    const launcher = builtClikcodeLauncher();
    const provisioned = await provisionChosenHarness({
      ...(launcher ? { launcher } : {}),
      harness, account, workspace: session.workspace, stateDir: stateDirectory(),
      builtins: [
        ...(conversations ? [conversations] : []),
        ...(!swarmRidesTurn(harness) && swarmEntry ? [swarmEntry] : []),
      ],
    });
    // A server taken back out is just as invisible to a running process,
    // which would go on asking for its sign-in.
    if (provisioned.mcpInstalled.length || provisioned.mcpRemoved.length) await closePersistentTransport(session.id);
    // Which conversation this is, for ClikCode's conversation MCP server the
    // vendor starts (search/mcp.ts): it leaves this one out of its answers.
    const environment = { ...turnEnvironment(harness, account, session.permissionMode ?? 'ask'), CLIKCODE_SESSION_ID: session.id };
    // A provider with no signed-in account is signed in to when it is used
    // -- here, as its turn starts -- never when it is merely chosen (opening
    // ClikCode picks one without asking anything).
    if (account.status === 'needs_login' && !authRetried && !await signInForTurn(environment)) {
      throw new Error(`${harness.displayName} is not signed in. Run \`${harnessCommand()} accounts login ${harness.command}\`.`);
    }
    // A vendor whose config could not take the conversation server gets it
    // with its ACP session instead (a CLI turn has no such channel).
    const sessionMcpServers = conversationsForAcpSession(conversations, provisioned.mcpSkipped,
      { CLIKCODE_SESSION_ID: session.id, ...(process.env.CLIKCODE_HOME ? { CLIKCODE_HOME: process.env.CLIKCODE_HOME } : {}) });
    // Goose resumes by its own id what was created under ClikCode's name.
    if (await adoptListedNativeId(harness, session, environment)) await checkpoint.persistNow();
    const transport = sessionTurnTransport(harness, session);
    activeTransport = transport;
    // A fresh native thread with prior ClikCode messages: see above. Also
    // covers an id ClikCode minted that the vendor never confirmed.
    let caughtTurnFailure: Error | undefined;
    let result: NativeTurnResult | undefined;
    let streamError: { message: string; statusCode?: number; kind?: string } | undefined;
    let cliOutputStarted = false;
    turnUsage = undefined;
    pendingWork.reset();
    swarmFold = emptySwarmFold();
    // Naming is for a new chat, and only from a reply that was actually
    // asked for a name -- so nothing about it may cross a retry. This loop
    // has five retry paths and each one either keeps this prompt or replaces
    // it; deciding here, from the prompt itself, is what makes that true for
    // all five instead of the ones someone remembered.
    titleStream = titleStreamForAttempt(titleStream, turnText, session);
    const runStructuredCliTurn = (): Promise<NativeTurnResult> => runVendorCliAttempt({
      harness, session, turnText, model, environment, images, signal, run, checkpoint,
      effort: turnEffort(), sharedObserver,
      onOutputStart: () => { cliOutputStarted = true; },
      onStreamError: (error) => { streamError = error; },
    });
    try {
      if (transport === 'structured-cli' || transport === 'text-cli') {
        result = await runStructuredCliTurn();
      } else {
        result = await runVendorSessionAttempt({
          harness, account, session, transport, turnText, model, environment, images, signal, run, checkpoint,
          sharedObserver, effort: turnEffort(), onSessionId, mcpServers: sessionMcpServers,
          runCli: runStructuredCliTurn,
        });
      }
    } catch (error) {
      if (isTurnCancelled(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_TOO_LARGE') throw error;
      caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
    }
    result = caughtTurnFailure
      ? { isError: true, text: caughtTurnFailure.message }
      : result!;
    // A harness that reports a failed call as its reply (Hermes, over ACP
    // and the CLI alike) declares what those replies look like.
    const replyError = !result.isError ? harnessReplyError(harness, result.text ?? '') : undefined;
    if (replyError) {
      // The notice is not the answer: take it off what is shown and saved, so
      // the next account continues from real progress rather than a banner.
      // Read from the saved answer, which the title filter already produced;
      // a notice-only reply clears it.
      const onScreen = harnessReplyError(harness, session.pendingTurn?.response ?? '');
      const withoutNotice = onScreen?.withoutNotice;
      if (withoutNotice) {
        checkpoint.response(withoutNotice, 'replace');
        prompter?.response(withoutNotice, 'replace');
      } else if (onScreen) {
        editAnswer('clear');
      }
      result = { ...result, isError: true, errorMessage: replyError.notice, ...(replyError.statusCode !== undefined ? { statusCode: replyError.statusCode } : {}) };
    }
    if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
    if (!result.isError && !session.nativeSessionPreallocated) await adoptListedNativeId(harness, session, environment);
    if (session.nativeSessionId) keepTransport(transport);
    // A route that keeps no history: forget the session, so the next turn
    // opens a fresh one and carries ClikCode's own transcript (the fresh-
    // thread replay above) instead of resuming into an empty memory.
    const statelessProvider = session.nativeTransport !== 'acp' && keepsNoHistory(harness, model);
    if (!result.isError && (result.nativeSessionStateless || statelessProvider)) forgetNativeThread(session);
    // A non-zero exit code alone is not treated as failure here: by this
    // point nativeTurnResult has already thrown if it found neither assistant
    // text nor tool work, so a result means a real, complete turn. A harness
    // can legitimately exit non-zero because one internal sub-step failed
    // (e.g. Codex's own shell-command execution) while still producing a full
    // final answer -- the exit code by itself doesn't distinguish that from a
    // genuine failure, but an explicit isError/errorMessage signal does. An
    // empty `text` after tool work (`noAssistantText`) is success everywhere.
    if (caughtTurnFailure || result.isError) {
      const carried = (caughtTurnFailure ?? {}) as { statusCode?: number; errorKind?: string };
      // A thrown transport error carries its own stderr/streams.
      const declared = caughtTurnFailure ? undefined : nativeTurnFailure(harness, result);
      const failure = caughtTurnFailure ?? declared!.failure;
      const failureKind = classifyAccountFailure(failure, {
        statusCode: result.statusCode ?? carried.statusCode ?? streamError?.statusCode,
        errorKind: result.errorKind ?? carried.errorKind ?? streamError?.kind,
        ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
        ...(declared ? { isResultError: declared.isResultError } : {}),
      });
      lifecycle('worker.turn.attempt-failed', {
        kind: failureKind, transport, account: account.id.slice(0, 8),
        message: (failure instanceof Error ? failure.message : String(failure)).slice(0, 8000),
      });
      // A reasoning level the model does not take. Which levels a model
      // takes is often only stated by the refusal itself ("Unknown effort
      // \"medium\". Supported: high, max." -- Command Code, where it varies
      // per model and is published nowhere else). The conversation drops to
      // the vendor's own default and says so, then runs the turn once more.
      if (!cliOutputStarted && turnEffort() && !effortRetried && isEffortRefusal(failure)) {
        effortRetried = true;
        prompter?.activity(chalk.yellow(`${harness.displayName} does not take effort ${session.effort} on this model; using its default`));
        session.effortRefused = effortKey();
        await checkpoint.persistNow();
        continue;
      }
      // A turn contract an older vendor build rejects outright: retry once on
      // the harness's declared fallback contract, and remember it for that build.
      if (failureKind === 'other' && !cliOutputStarted && harness.fallbackTurn
        && (transport === 'structured-cli' || transport === 'text-cli') && !await usesFallbackTurn(harness)) {
        await rememberFallbackTurn(harness);
        prompter?.phase('using compatibility turn');
        continue;
      }
      // The account is marked signed out by accounts.after, if signing in
      // here does not fix it.
      if (failureKind === 'authentication-required') {
        // Reactive counterpart to aiHarnessSelect's proactive login check:
        // a harness with no statusArgv gets no pre-turn "are you logged
        // in?" probe at all (harnessNeedsLogin returns false without
        // one), so its first real failure signal is the turn itself
        // erroring out -- previously surfaced as a raw, unhelpful "exited
        // N: {...}" message with no attempt to actually fix it. Same
        // suspend/login/resume mechanism aiHarnessSelect uses, triggered
        // here instead of only at provider-switch time.
        if (!authRetried && await signInForTurn(environment)) {
          // The failed reply may already be on screen; the retry replaces it.
          editAnswer('clear');
          continue;
        }
      }
      if (failureKind === 'native-thread-invalid' && !nativeThreadRetried) {
        // Confirmed live: switching this session to a different account of
        // the same provider used to leave a stale nativeSessionId in
        // place, and resuming it failed with exactly this vendor error.
        // That specific write path is now fixed separately, but recovering
        // here too means any OTHER way a thread id ends up invalid degrades
        // to "start fresh with real context replayed" instead of a hard
        // failure -- the actual answer to "how do conversations resume
        // regardless of provider or account": session.messages is the
        // durable, vendor-agnostic source of truth, and nativeSessionId is
        // a disposable optimization, never a requirement.
        nativeThreadRetried = true;
        await closePersistentTransport(session.id);
        forgetNativeThread(session);
        turnText = await retell(session.pendingTurn?.outputStarted || cliOutputStarted ? INTERRUPTED_TURN_REQUEST : askedText, 'clear');
        continue;
      }
      const fallback = await accounts.after(failure, failureKind, signal);
      const carriedThread = await moveThreadToAccount(session, harness, account, fallback);
      await accounts.switchTo(fallback, failureKind);
      nativeThreadRetried = false;
      // The answer on screen stays when this attempt already wrote one: the
      // next account carries on from it, so clearing it made the first half
      // vanish. An attempt that produced nothing is asked again in the
      // request's own words. "Continue" there points at the previous
      // finished turn, and retelling the transcript repeats a conversation
      // the carried thread already holds.
      const wrote = Boolean(session.pendingTurn?.outputStarted || cliOutputStarted);
      const edit = session.pendingTurn?.response?.trim() ? 'new-paragraph' : 'clear';
      const nextRequest = wrote ? INTERRUPTED_TURN_REQUEST : askedText;
      if (carriedThread) {
        // ('present' counts as much as 'carried': both accounts run this
        // harness against one vendor home, so the thread never had to move.)
        turnText = nextRequest;
        if (wrote) continueAnswer(edit);
      } else {
        // Built while the interrupted attempt's touched-file hints are still
        // on the checkpoint. The only path that rewrites the conversation:
        // this vendor's thread cannot be copied across.
        turnText = await retell(nextRequest, edit);
      }
      continue;
    }
    session.nativeStartedAt ??= new Date().toISOString();
    delete session.nativeSessionPreallocated;
    // The harness exited with a tool it never settled. Another model turn
    // cannot collect output from a process that has already gone.
    if (pendingWork.outstanding > 0) {
      const count = pendingWork.outstanding;
      prompter?.activity(chalk.yellow(count === 1
        ? 'The harness exited while a tool was still running.'
        : `The harness exited while ${count} tools were still running.`));
    }
    // The assignment inside noteUsage is invisible to control-flow, which
    // otherwise treats this as definitely undefined.
    const usage = turnUsage as TurnUsage | undefined;
    const invocation = recordInvocation(state, { sessionId: session.id, accountId: account.id, provider: harness.provider, model, startedAt, usage });
    recordSuccessfulAccountTurn(state, account, invocation);
    showStopReason(prompter, usage?.stopReason);
    // Completion always extracts the title, including when the stream that
    // filtered an earlier attempt was replaced during a retry.
    const completedText = await completeTurnCheckpoint(session, checkpoint, result.text, {
      title: titleStream?.title,
      bare: titleStream?.naming === true,
      ...(titleSource === 'vendor'
        ? { vendor: () => nativeGeneratedTitle(harness, session.nativeSessionId, session.workspace, environment) }
        : {}),
    });
    await writeState(state);
    if (!prompter) emitHarnessOutput({ session, text: completedText, usage: { attributedBy: harness.command, ...usage }, invocation, ...accounts.switched() });
    return;
  }
  } finally {
    stopSwarmWatch();
    await checkpoint.flush();
  }
}
