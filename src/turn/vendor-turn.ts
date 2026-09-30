/** Run a turn through a vendor's CLI or structured session protocol. */
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { randomUUID } from 'node:crypto';
import { accountSwitchNotice, accountSwitchPhase } from './failover.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { createPendingWorkTracker, mayContinuePendingWork, pendingContinuationDelayMs, PENDING_CONTINUATION_PROMPT } from './pending-work.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
import { accountAfterFailure, initialAccountChoice, turnAccountRecorder, turnBackendForAccount, type FailoverTally } from './account-routing.js';
import { classifyAccountFailure, type AccountFailureKind } from './failover.js';
import { failoverPrompt, INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { interruptedTurnFailoverPrompt } from './interrupted-turn-prompt.js';
import { carryNativeSession } from '../session/carry.js';
import { sessionTitleSource, prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { nativeGeneratedTitle } from '../session/discovery/titles.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import { harnessSupportsImages, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { writeState } from '../session/state/write.js';
import { syncAccountIdentityAfterLogin, withVendorTerminal } from '../commands/account.js';
import { ensureTurboFitForTurn } from '../commands/ai/turbofit.js';
import { closePersistentTransport, rememberFallbackTurn, usesFallbackTurn, nativeAvailableCommands } from './vendor-process.js';
import { completeTurnCheckpoint, startTurnCheckpoint } from './turn-journal.js';
import { synchronizeNativeTranscript } from './handoff.js';
import { turnEnvironment } from './turn-environment.js';
import type { TurnRunOptions } from './session-turn.js';
import { runVendorCliAttempt } from './vendor-cli-attempt.js';
import { runVendorSessionAttempt } from './vendor-session-attempt.js';
import { emitHarnessOutput } from '../harness/output.js';
import { harnessTurnTransport } from '../harness/transport/select.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { harnessCanRunTurns, harnessLoginArgvForModel, harnessReplyError, modelProvider } from '../runtime/lazy-bridge.js';
import { prepareAttachments } from '../session/attachments.js';
import { addTurnUsage, stopReasonNotice, type TurnUsage } from '../harness/protocol/turn-usage.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { durableAnswer, sessionTranscriptMessages } from './checkpoint.js';
import { forgetNativeThread } from '../session/native-thread.js';

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
/** A vendor refusing the reasoning level itself, in the words the CLIs use. */
const EFFORT_REJECTED = /\b(?:unknown|invalid|unsupported|not supported)\b[^\n]{0,40}\b(?:reasoning[ _-]?)?effort\b|\beffort\b[^\n]{0,40}\b(?:is not supported|not supported|unsupported|invalid)\b/i;

/** Whether a failed turn is the vendor refusing the reasoning level: read
 * from its message and the stderr it carries, never from a model's reply. */
export function isEffortRefusal(failure: Error): boolean {
  const stderr = (failure as { stderrTail?: unknown }).stderrTail;
  return EFFORT_REJECTED.test([failure.message, typeof stderr === 'string' ? stderr : ''].join('\n'));
}

const RETRY_EDITS = { clear: ['', 'replace'], 'new-paragraph': ['\n\n', 'append'] } as const;

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
  // not be attributed to anything. Cheap to call (the catalog is cached
  // for five minutes) and persisted, so the next turn on this session
  // finds it already there.
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
  let switchedFrom: string | undefined;
  /** Why the turn left that account: the failure it met there. */
  let switchReason: AccountFailureKind = 'quota-exhausted';
  const tally: FailoverTally = { attempted: new Set(), exhaustedAny: false };
  const onVendorBackend = (item: AiHarnessAccount): boolean => turnBackendForAccount(item) === 'vendor';
  /** The vendor's own thread, carried into the account taking over, so it
   * resumes with everything it actually said and did rather than a retelling
   * of it. Undefined where that cannot be done -- a harness whose transcript
   * layout is not known, a file that is not on disk. */
  const carryThread = (from: AiHarnessAccount, to: AiHarnessAccount) => carryNativeSession({
    harness, nativeId: session.nativeSessionId, workspace: session.workspace,
    from: turnEnvironment(harness, from), to: turnEnvironment(harness, to),
  });
  /** The two edits a retry makes to the answer, in the saved turn and on
   * screen alike: clear it, or start a new paragraph after it. Only these --
   * the model's own words reach the screen through emitResponseDelta alone. */
  const editAnswer = (edit: keyof typeof RETRY_EDITS): void => {
    checkpoint.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
    prompter?.response(RETRY_EDITS[edit][0], RETRY_EDITS[edit][1]);
  };
  /** Moving the turn to another account: said before the retry, not after it
   * returns (it happens inside one await chain and would otherwise look
   * instantaneous), and with the reason, so a crash is not called a spent plan. */
  const recordAccount = turnAccountRecorder(session, () => checkpoint.persistNow());
  const switchAccount = async (to: AiHarnessAccount, why: AccountFailureKind): Promise<void> => {
    prompter?.activity(chalk.yellow(accountSwitchNotice(why, to.label)));
    prompter?.phase(accountSwitchPhase(to.label));
    await closePersistentTransport(session.id);
    switchedFrom = account.label;
    account = to;
    await recordAccount(to);
  };
  try {
  const initial = initialAccountChoice(state, account, session.accountFailover, onVendorBackend, tally.attempted);
  if (initial.kind === 'exhausted') { await writeState(state); throw initial.error; }
  if (initial.kind === 'switch') {
    // The thread goes with the conversation, as on a switch mid-turn; only
    // one that cannot be carried starts afresh.
    if (!await carryThread(account, initial.account)) forgetNativeThread(session);
    await switchAccount(initial.account, 'quota-exhausted');
    await checkpoint.persistNow();
  }
  // A fresh native thread (no nativeSessionId yet) with prior ClikCode
  // messages already on the session means this conversation is continuing
  // under a different native identity than whatever produced those messages
  // — a cross-provider /resume, most commonly. ClikCode's own transcript
  // shows continuity either way, but the vendor process about to start has
  // no memory of any of it unless it's carried in the prompt itself; without
  // this, "continuing under Claude Code" is cosmetic in the UI only. The
  // quota-failover retry below does its own version of this for the
  // mid-conversation case; this covers every other route into a fresh
  // native thread with history already behind it.
  if ((!session.nativeSessionId || session.nativeSessionPreallocated) && baseMessages.length > 0) {
    turnText = failoverPrompt(baseMessages, turnText);
  }
  // Bounded to one attempt: this is a reactive fallback for exactly the
  // case aiHarnessSelect's own proactive check can't catch -- a harness
  // with no statusArgv (nothing to scriptably ask "am I logged in?"
  // before the turn even starts), where the *first* real signal is the
  // turn itself failing. Retrying more than once would risk a loop if
  // login genuinely doesn't fix it (wrong account, network issue, etc.).
  let authRetried = false;
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
    const shown = addTurnUsage(carriedPendingUsage, turnUsage)!;
    session.lastUsage = { ...shown, at: new Date().toISOString() };
    prompter?.setTurnUsage(shown);
  };
  const pendingWork = createPendingWorkTracker(harness.command);
  let pendingContinuations = 0;
  const pendingWorkStartedAt = Date.now();
  /** Tokens from earlier attempts of this same continued turn; the loop
   *  clears turnUsage on every pass, which is right for a failover and
   *  wrong for a continuation. */
  let carriedPendingUsage: TurnUsage | undefined;
  const onActivity = (event: HarnessActivityEvent): void => {
    pendingWork.note(event);
    checkpoint.activity(event);
    if (prompter) prompter.activityEvent(event);
    else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
  };
  /** A transport's thought is the whole of it so far: one row per id,
   *  replaced as it grows (activity-events.ts thoughtLabel). */
  const onThought = (thought: string, id?: string): void => {
    const label = thoughtLabel(thought);
    if (label) onActivity({ kind: 'thinking', label, ...(id ? { id } : {}) });
  };
  const onSessionId = async (nativeSessionId: string): Promise<void> => {
    if (session.nativeSessionId === nativeSessionId && !session.nativeSessionPreallocated) return;
    session.nativeSessionId = nativeSessionId;
    delete session.nativeSessionPreallocated;
    await checkpoint.persistNow();
  };
  /** The response-delta rule, in one place. Every transport owes the same
   * three steps -- through the title filter, then to the checkpoint and to
   * the screen -- and they differed only in which default mode they passed.
   * This was three copies, and drift between them was not hypothetical: the
   * structured-CLI copy once skipped the title filter entirely, which made
   * what was displayed differ from what was persisted, and the transcript
   * then read the saved answer as new content and drew the whole reply a
   * second time. That was the duplicated response. One function cannot
   * drift from itself. */
  const emitResponseDelta = (text: string, mode: 'append' | 'replace' = 'append'): void => {
    const visible = titleStream ? titleStream.push(text, mode) : text;
    // undefined: the title filter is still holding the head back. '': a
    // replace arrived before that question was settled. Either one used to
    // be written through, and an empty replace clears the answer already
    // on screen -- the reply flashed, then was gone.
    if (!visible) return;
    // A later snapshot that is not a longer copy of what is already on
    // screen must not replace it. Vendors resend only the last block; taking
    // that as the whole answer is what made earlier paragraphs vanish.
    const kept = mode === 'replace' ? durableAnswer(session.pendingTurn?.response ?? '', visible) : visible;
    if (mode === 'replace' && kept !== visible) return;
    checkpoint.response(visible, mode);
    prompter?.response(visible, mode);
  };
  /** The observer members every transport implements identically. Each
   * transport spreads this and then overrides only what genuinely differs
   * for it (codex's rate limits and steering, the structured CLI's own idle
   * bookkeeping) -- so a member absent from a transport's literal is a
   * deliberate default, not a forgotten one. */
  const sharedObserver = {
    onActivity, onThought, onUsage: noteUsage,
    onResponseDelta: emitResponseDelta,
    onPhase: (phase: string) => prompter?.phase(phase),
    onNotice: (message: string) => prompter?.activity(chalk.yellow(message)),
    onPlan: (entries: readonly HarnessPlanEntry[]) => prompter?.setPlan(entries),
    // A native harness runs its OWN tools, so ClikCode has no rule to
    // remember on its behalf -- and with no rule offered the prompter never
    // returns 'always' anyway. Collapsed to a boolean here so that boundary
    // is stated rather than implied.
    onApproval: async (title: string, detail?: string) => (await prompter?.approval(title, detail)) === true,
    onAvailableCommands: (commands: readonly HarnessAvailableCommand[]) => { nativeAvailableCommands.set(session.id, commands); },
  } satisfies HarnessTurnObserver;
  for (;;) {
    const environment = turnEnvironment(harness, account, session.permissionMode ?? 'ask');
    const hasImages = images.length > 0;
    const transport = harnessTurnTransport(harness, hasImages, { acpImages: true });
    // A fresh native thread with prior ClikCode messages: see above. Also
    // covers an id ClikCode minted that the vendor never confirmed.
    let caughtTurnFailure: Error | undefined;
    let result: NativeTurnResult | undefined;
    let streamError: { message: string; statusCode?: number; kind?: string } | undefined;
    let cliOutputStarted = false;
    turnUsage = undefined;
    pendingWork.reset();
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
          sharedObserver, effort: turnEffort(), onSessionId, runCli: runStructuredCliTurn,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_TOO_LARGE') throw error;
      caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
    }
    result = caughtTurnFailure
      ? { isError: true, text: caughtTurnFailure.message }
      : result!;
    // A harness that reports a failed call as its reply (Hermes, over ACP
    // and the CLI alike) declares what those replies look like.
    const replyError = !result.isError ? harnessReplyError(harness, result.text ?? '') : undefined;
    if (replyError) result = { ...result, isError: true, ...(replyError.statusCode !== undefined ? { statusCode: replyError.statusCode } : {}) };
    if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
    // A route that keeps no history: forget the session, so the next turn
    // opens a fresh one and carries ClikCode's own transcript (the fresh-
    // thread replay above) instead of resuming into an empty memory.
    const statelessProvider = Boolean(model && harness.turn?.statelessProviders?.includes(modelProvider(harness, model) ?? ''));
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
      const failure = caughtTurnFailure ?? Object.assign(new Error(`${harness.displayName}: ${result.text}`), { statusCode: result.statusCode });
      const failureKind = classifyAccountFailure(failure, {
        statusCode: result.statusCode ?? carried.statusCode ?? streamError?.statusCode,
        errorKind: result.errorKind ?? carried.errorKind ?? streamError?.kind,
        ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
        // Only the vendor's own declared error result is safe to read as
        // wording; a thrown transport error carries its own stderr/streams.
        ...(caughtTurnFailure ? {} : { isResultError: true }),
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
      // An `experimental` structured contract an older vendor build rejects
      // outright: retry once on the proven fallback contract, and remember it.
      if (failureKind === 'other' && !cliOutputStarted && harness.experimental && harness.fallbackTurn
        && (transport === 'structured-cli' || transport === 'text-cli') && !await usesFallbackTurn(harness)) {
        await rememberFallbackTurn(harness);
        prompter?.phase('using compatibility turn');
        continue;
      }
      if (failureKind === 'authentication-required') {
        account.status = 'needs_login';
        await checkpoint.persistNow();
        // Reactive counterpart to aiHarnessSelect's proactive login check:
        // a harness with no statusArgv gets no pre-turn "are you logged
        // in?" probe at all (harnessNeedsLogin returns false without
        // one), so its first real failure signal is the turn itself
        // erroring out -- previously surfaced as a raw, unhelpful "exited
        // N: {...}" message with no attempt to actually fix it. Same
        // suspend/login/resume mechanism aiHarnessSelect uses, triggered
        // here instead of only at provider-switch time.
        // A multi-provider harness signs in to the provider the model runs
        // on (`hermes auth add opencode-free`), not the whole harness.
        const signInArgv = harnessLoginArgvForModel(harness, model);
        if (!authRetried && prompter && signInArgv) {
          authRetried = true;
          await closePersistentTransport(session.id);
          const signIn = { ...harness, loginArgv: signInArgv };
          const signInName = signInArgv === harness.loginArgv ? harness.displayName : `${harness.displayName} › ${model ? modelProvider(harness, model) : ''}`;
          // A worker has no terminal: its client runs the sign-in and says
          // when it is done. Without that the vendor's login ran here, in a
          // detached process, and could never finish.
          const signedIn = await (prompter.signIn
            ? prompter.signIn({ command: harness.command, argv: signInArgv, environment, name: signInName })
            : withVendorTerminal(prompter, signIn, () => loginNativeHarness(signIn, environment), signInName))
            .then(() => true, (error: unknown) => {
              // The turn then ends on its own authentication error, which
              // says what to do; this says why the sign-in did not fix it.
              prompter.activity(chalk.yellow(`sign-in to ${signInName} did not finish: ${error instanceof Error ? error.message : String(error)}`));
              return false;
            });
          if (signedIn) {
            account = await syncAccountIdentityAfterLogin(harness, account, state);
            await recordAccount(account);
            // The failed reply may already be on screen; the retry replaces it.
            editAnswer('clear');
            continue;
          }
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
        turnText = interruptedTurnFailoverPrompt(session, { requestContext });
        editAnswer('clear');
        continue;
      }
      const fallback = await accountAfterFailure({
        state, session, account, failure, kind: failureKind, signal, matchesBackend: onVendorBackend, tally,
        persist: () => checkpoint.persistNow(),
        notice: (message) => prompter?.activity(chalk.yellow(message)),
      });
      const carriedThread = await carryThread(account, fallback);
      switchReason = failureKind;
      await switchAccount(fallback, failureKind);
      nativeThreadRetried = false;
      if (carriedThread) {
        // The same thread, under a new account: it holds the conversation,
        // the interrupted request and every tool call it had already made.
        // All it is owed is the word to carry on.
        //
        // 'present' counts here as much as 'carried'. It means the thread
        // never had to move, because both accounts run this harness against
        // the same vendor home.
        turnText = INTERRUPTED_TURN_REQUEST;
        // And the answer on screen stays. The thread already contains what
        // the first account wrote, and the next one is told to carry on
        // without repeating it -- so clearing it here made the first half of
        // the answer vanish and a continuation appear in its place. The
        // continuation starts a new paragraph instead of running into it.
        const partial = session.pendingTurn?.response ?? '';
        if (partial.trim() && !/\n\s*\n\s*$/.test(partial)) {
          editAnswer('new-paragraph');
        }
      } else {
        forgetNativeThread(session);
        // Built while the interrupted attempt's touched-file hints are still
        // on the checkpoint; only then is the partial response cleared,
        // because a fresh thread answers the whole request again and keeping
        // the old half would show it twice (the direct-API path does the
        // same).
        turnText = interruptedTurnFailoverPrompt(session, { requestContext });
        editAnswer('clear');
      }
      continue;
    }
    session.nativeStartedAt ??= new Date().toISOString();
    delete session.nativeSessionPreallocated;
    // The harness ended the turn with a tool it never settled -- it
    // backgrounded a command and stopped. Re-drive it so it goes and reads
    // the result, instead of leaving the answer stranded in a task log and
    // the session looking finished. See pending-work.ts.
    if (pendingWork.outstanding > 0
      && mayContinuePendingWork(pendingContinuations, Date.now() - pendingWorkStartedAt)) {
      const waited = pendingContinuationDelayMs(pendingContinuations);
      pendingContinuations += 1;
      prompter?.phase('waiting on background command');
      await new Promise((resolve) => setTimeout(resolve, waited));
      if (signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
      prompter?.activity(chalk.dim('continuing after background command'));
      carriedPendingUsage = addTurnUsage(carriedPendingUsage, turnUsage);
      turnText = PENDING_CONTINUATION_PROMPT;
      continue;
    }
    // One invocation for the whole turn, however many continuations it took:
    // recording one per pass counted every earlier pass again each time
    // (usage-learning fits its limits from exactly these records).
    const usage = addTurnUsage(carriedPendingUsage, turnUsage);
    const invocation = {
      id: randomUUID(), accountId: account.id, provider: harness.provider, ...(model ? { model } : {}),
      at: new Date().toISOString(), sessionId: session.id,
      ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
      ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
      ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      latencyMs: Date.now() - startedAt,
    };
    state.invocations.push(invocation);
    recordSuccessfulAccountTurn(state, account, invocation.at);
    // An answer the vendor cut short says so, beside the answer.
    const stopped = stopReasonNotice(usage?.stopReason);
    if (stopped && prompter) prompter.activity(chalk.yellow(stopped));
    else if (stopped && !isJsonDefaultMode()) process.stderr.write(`${chalk.yellow(stopped)}\n`);
    // Completion always extracts the title, including when the stream that
    // filtered an earlier attempt was replaced during a retry.
    const completedText = await completeTurnCheckpoint(session, checkpoint, result.text, {
      title: titleStream?.title,
      ...(titleSource === 'vendor'
        ? { vendor: () => nativeGeneratedTitle(harness, session.nativeSessionId, session.workspace, environment) }
        : {}),
    });
    // The vendor subprocess owns persistence. Re-read its transcript after
    // exit so any source-side turns/events that were not represented by the
    // final response are reflected in ClikCode before the turn is saved.
    await synchronizeNativeTranscript(state, session);
    await writeState(state);
    if (!prompter) emitHarnessOutput({ session, text: completedText, usage: { attributedBy: harness.command, ...usage }, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: switchReason } : {}) });
    return;
  }
  } finally {
    await checkpoint.flush();
  }
}
