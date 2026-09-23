/**
 * Running one turn, end to end.
 *
 * Both routes live here because they are the same shape seen twice: resolve an
 * account, open a checkpoint, stream a reply somewhere, name the session, fail
 * over if the account is spent, and close the checkpoint whatever happened.
 * What differs is only where the reply comes from -- a local harness over one
 * of four transports, or the gateway.
 */
import { randomUUID } from 'node:crypto';
import { usageExhaustedMessage } from './usage-exhausted.js';
import { accountFailureReason } from './failover.js';
import { recordAllowed, recordRefused } from '../harness/accounts/usage-learning.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stdout as output } from 'node:process';
import type Conf from 'conf';
import chalk from 'chalk';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
import { CLIKCODE_USER_AGENT, CLIKCODE_VERSION } from '../version.js';
import { gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn } from '../gateway/harness.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { captureNativeHarness } from '../harness/transport/native/command.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { captureNativeHarnessTurn, createTurnIdleController, noteTurnActivityEvent } from '../harness/transport/native/turn.js';
import { addTurnUsage, createPendingWorkTracker, mayContinuePendingWork, pendingContinuationDelayMs, PENDING_CONTINUATION_PROMPT } from './pending-work.js';
import { classifyAccountFailure, failoverPrompt, INTERRUPTED_TURN_REQUEST, interruptedTurnFailoverPrompt, usageLabelRemainingPercent } from './failover.js';
import { carryNativeSession } from '../session/carry.js';
import { extractSessionTitle, sessionTitleSource, shouldRequestTitle, StreamingTitle, withTitleRequest } from '../session/title.js';
import { nativeGeneratedTitle } from '../session/discovery/titles.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import { nativeTurnResult, type NativeTurnResult } from '../harness/protocol/turn-result.js';
import { nativeTurnUsage } from '../harness/protocol/turn-usage.js';
import { harnessSupportsImages, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { harnessCommand, harnessStatePath } from '../session/state/paths.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { accountUsageLabel } from '../harness/accounts/account-usage.js';
import { recordDerivedUsage, recordNativeStreamUsage } from '../harness/accounts/stream-usage.js';
import { codexRateLimitsReading } from '../harness/accounts/usage-probes.js';
import { harnessNeedsLogin, syncAccountIdentityAfterLogin } from '../commands/account.js';
import { closePersistentTransport, DurableTurnCheckpoint, fallbackTurnHarnesses, nameSession, nativeAvailableCommands, nextUsableFailoverAccount, persistentTransportFor, persistentTransports, synchronizeNativeTranscript, turnEnvironment, type TurnRunOptions } from './runtime.js';
import { emitHarnessOutput, line } from '../harness/output.js';
import { runCodexAppServerTurn, type CodexAppServerTurnInput, type CodexSession } from '../harness/transport/codex-app-server.js';
import { runAcpTurn, type AcpSession, type AcpTurnInput } from '../harness/transport/acp-client.js';
import { harnessTurnTransport } from '../harness/transport/select.js';
import { harnessAcpLaunch, harnessCanRunTurns, isDirectModelProvider, maxPromptArgvBytes, nativeHarnessTurnArgv, promptExceedsArgvLimit } from '../runtime/lazy-bridge.js';
import { reportStructuredLine } from '../harness/events/structured.js';
import { prepareAttachments } from '../session/attachments.js';
import { localApiKey } from '../daemon/server.js';
import { appServerThreadOverrides, declaredOptionArgv, normalizeTurnUsage, type NormalizedTurnUsage } from '../harness/transport/options.js';
import { sessionTranscriptMessages } from './checkpoint.js';

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
export async function aiSessionSend(
  id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const prompter = run.prompter;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('use aiGatewaySessionSend for gateway sessions');
  if (!session.accountId) throw new Error('local AI session has no account selected');
  let account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  let model: string | null = session.model ?? account.models[0] ?? null;
  if (model && account.models.length > 0 && !account.models.includes(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  let turnText = `${text}${prepared.textContext}`;
  const startedAt = Date.now();

  // Auth and transport are separate questions, and conflating them was a real
  // bug: this fork used to be `authKind === 'vendor-cli'`, so ANY other auth
  // kind fell through to a direct HTTP turn. That is right for the five
  // harnesses whose provider is a genuine model API (anthropic, openai,
  // google, xai, nous) and impossible for the twelve that name themselves as
  // their provider -- aider, cline, continue, goose, kilo, kimi, kiro,
  // opencode, openhands, pi, qwen, mistral-vibe. There is no aider endpoint;
  // aider talks to whichever vendor the user's key belongs to. All twelve
  // advertise api-key in localAuth, so picking it was a few keystrokes away
  // and threw a raw `unknown AI provider: aider` from inside the registry.
  //
  // An API key is a credential, not a transport. Where the provider has no
  // directly addressable model API, the key still reaches the tool -- the
  // child inherits this process's environment (see transport/native's
  // `env: { ...process.env, ...envOverrides }`) and an api-key account's
  // credentialRef already names that variable -- so the correct behaviour is
  // to run the vendor CLI, exactly as vendor-cli auth does.
  if (account.authKind === 'vendor-cli' || !isDirectModelProvider(account.provider)) {
    const harness = session.nativeHarness
      ? localHarnessForCommand(session.nativeHarness)
      : localHarnessForProvider(account.provider);
    if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
    if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
    if (harness.provider !== account.provider) throw new Error(`session provider ${harness.displayName} does not match account "${account.label}"`);
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
    // An unnamed chat gets a title from the harness that writes one, and asks
    // the model for one where the harness does not. The request rides on this
    // turn's text only -- never on what is stored as the user's message -- and
    // the answer is stripped of it before anyone sees it.
    const titleSource = sessionTitleSource(harness);
    // Up to TITLE_REQUEST_ATTEMPTS turns, and no more: a chat that has used
    // up its attempts has had its chance, and pinning the request to every
    // later turn forever would keep editing prompts the user can see the
    // effect of.
    const askingForTitle = titleSource === 'ask' && shouldRequestTitle(session);
    const titleStream = askingForTitle ? new StreamingTitle() : undefined;
    if (askingForTitle) {
      turnText = withTitleRequest(turnText);
      session.titleAttempts = (session.titleAttempts ?? 0) + 1;
    }
    const supportsImages = harnessSupportsImages(harness);
    const images = supportsImages ? prepared.images : [];
    if (prepared.images.length && !supportsImages) {
      turnText += `\n\nImage files available in the workspace:\n${prepared.images.map((path) => `- ${path}`).join('\n')}`;
    }
    session.nativeHarness = harness.command;
    session.provider = harness.provider;
    session.workspace ??= process.cwd();
    const baseMessages = sessionTranscriptMessages(session);
    const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
    run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => checkpoint.unqueueSoon(submission));
    let switchedFrom: string | undefined;
    /** Whether any account actually ran out, as opposed to failing some other
     * way. Decides whether "Usage Exhausted" is the truth at the end. */
    let exhaustedAnyAccount = false;
    const attemptedAccounts = new Set<string>();
    try {
    if (session.accountFailover === 'on-quota-exhausted' && account.quotaState === 'exhausted') {
      const currentRemaining = usageLabelRemainingPercent(await accountUsageLabel(account, state));
      if (currentRemaining !== undefined && currentRemaining > 0) account.quotaState = 'available';
      else {
        attemptedAccounts.add(account.id);
        const fallback = await nextUsableFailoverAccount(
          state, account, (item) => item.authKind === 'vendor-cli', attemptedAccounts,
        );
        if (!fallback) {
          await writeState(state);
          throw new Error(usageExhaustedMessage(
          state.accounts.filter((item) => attemptedAccounts.has(item.id) || item.id === account?.id),
        ));
        }
        switchedFrom = account.label;
        prompter?.activity(`${chalk.yellow('quota exhausted')} ${chalk.dim(`${account.label} → ${fallback.label}`)}`);
        prompter?.phase(`switching to ${fallback.label}`);
        account = fallback;
        session.accountId = fallback.id;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
        await checkpoint.persistNow();
      }
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
    const declaredOptions = localHarnessCapabilityManifest(harness).options;
    /** Shared by every transport: usage seen on the wire for this attempt. */
    let turnUsage: NormalizedTurnUsage | undefined;
    const noteUsage = (raw: unknown): void => {
      const usage = normalizeTurnUsage(raw);
      if (!usage) return;
      turnUsage = { ...turnUsage, ...usage };
      session.lastUsage = { ...turnUsage, at: new Date().toISOString() };
      prompter?.setTurnUsage(turnUsage);
    };
    const pendingWork = createPendingWorkTracker(harness.command);
    let pendingContinuations = 0;
    const pendingWorkStartedAt = Date.now();
    /** Tokens from earlier attempts of this same continued turn; the loop
     *  clears turnUsage on every pass, which is right for a failover and
     *  wrong for a continuation. */
    let carriedPendingUsage: NormalizedTurnUsage | undefined;
    const onActivity = (event: HarnessActivityEvent): void => {
      pendingWork.note(event);
      checkpoint.activity(event);
      if (prompter) prompter.activityEvent(event);
      else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
    };
    const onThought = (thought: string): void => {
      const label = thought.replace(/\s+/g, ' ').trim();
      if (label) onActivity({ kind: 'thinking', label: label.slice(0, 200) });
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
      if (visible === undefined) return;
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
      onPlan: (entries: readonly HarnessPlanEntry[]) => prompter?.setPlan(entries),
      onApproval: (title: string, detail?: string) => prompter?.approval(title, detail) ?? Promise.resolve(false),
      onAvailableCommands: (commands: readonly HarnessAvailableCommand[]) => { nativeAvailableCommands.set(session.id, commands); },
    } satisfies HarnessTurnObserver;
    for (;;) {
      const environment = turnEnvironment(harness, account, session.permissionMode ?? 'ask');
      const hasImages = images.length > 0;
      const transport = harnessTurnTransport(harness, hasImages, { acpImages: true });
      // A fresh native thread with prior ClikCode messages: see above. Also
      // covers an id ClikCode minted that the vendor never confirmed.
      let caughtTurnFailure: Error | undefined;
      let turnOutput: Awaited<ReturnType<typeof captureNativeHarnessTurn>> = { stdout: '', stderr: '', exitCode: 0 };
      let result: NativeTurnResult | undefined;
      let streamError: { message: string; statusCode?: number; kind?: string } | undefined;
      let cliOutputStarted = false;
      turnUsage = undefined;
      pendingWork.reset();
      const runStructuredCliTurn = async (): Promise<NativeTurnResult> => {
        const cliHarness: AiLocalHarnessDefinition = fallbackTurnHarnesses.has(harness.command) && harness.fallbackTurn
          ? { ...harness, turn: harness.fallbackTurn } : harness;
        const turn = cliHarness.turn;
        if (!turn) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
        if (promptExceedsArgvLimit(cliHarness, turnText)) {
          throw Object.assign(new Error(
            `${harness.displayName} takes its prompt as a command-line argument, and this request is ${Math.ceil(Buffer.byteLength(turnText, 'utf8') / 1024)} KB (limit ${Math.floor(maxPromptArgvBytes() / 1024)} KB). Shorten it, or save the long content to a file in the workspace and ask the agent to read it.`,
          ), { code: 'ERR_PROMPT_TOO_LARGE' });
        }
        // Only a structured-CLI harness gets an id minted here, and it stays
        // marked "preallocated" until the vendor process is seen to own it:
        // a first attempt that dies early must re-create, never `--resume` an
        // id that was never created.
        let createdHere = Boolean(session.nativeSessionId && session.nativeSessionPreallocated);
        if (!session.nativeSessionId && cliHarness.session?.idKind === 'uuid' && turn.createIdPrefix) {
          session.nativeSessionId = randomUUID();
          session.nativeSessionPreallocated = true;
          createdHere = true;
        } else if (!session.nativeSessionId && cliHarness.session?.idKind === 'history-file' && turn.createIdPrefix) {
          const nativeDirectory = join(harnessStatePath(), '..', 'native', cliHarness.command);
          await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
          session.nativeSessionId = join(nativeDirectory, `${session.id}.history.md`);
          session.nativeSessionPreallocated = true;
          createdHere = true;
        } else if (!session.nativeSessionId && cliHarness.session?.createSessionArgv) {
          session.nativeSessionId = await captureNativeHarness(cliHarness, cliHarness.session.createSessionArgv, environment);
          createdHere = true;
        }
        const argv = nativeHarnessTurnArgv(cliHarness, {
          prompt: turnText, nativeSessionId: session.nativeSessionId, createdHere,
          launchedBefore: Boolean(session.nativeStartedAt), model, workspace: session.workspace, effort: session.effort,
          permissionMode: session.permissionMode ?? 'ask', images, options: session.harnessOptions,
        });
        // Persist an allocated native identity before the provider starts so an
        // interrupted turn cannot accidentally fork the centralized conversation.
        if (createdHere) await checkpoint.persistNow();
        const confirmNativeSession = (): void => {
          if (!session.nativeSessionPreallocated) return;
          delete session.nativeSessionPreallocated;
          checkpoint.touch();
        };
        const idle = createTurnIdleController();
        turnOutput = await captureNativeHarnessTurn(cliHarness, argv, environment, {
          cwd: session.workspace,
          signal,
          idleController: idle,
          stdinText: turn.promptInput === 'stdin' ? turnText : undefined,
          onStdoutLine: (lineText) => {
            // The same observer every other transport is handed. What is left
            // here is the turn loop's own bookkeeping, which no line parser
            // should be doing: confirming an optimistically minted session id,
            // the quota probe, and persisting what the harness says about
            // itself.
            const outcome = reportStructuredLine(cliHarness, lineText, {
              ...sharedObserver,
              // Only the idle bookkeeping is this transport's own: a line on
              // stdout is the sole proof a one-shot CLI is still working.
              onResponseDelta: (text, mode) => {
                cliOutputStarted = true;
                idle.noteActivity();
                emitResponseDelta(text, mode ?? 'append');
              },
              onActivity: (event) => {
                cliOutputStarted = true;
                noteTurnActivityEvent(idle, event);
                onActivity(event);
              },
            });
            if (outcome.live) confirmNativeSession();
            if (outcome.error) streamError = outcome.error;
            // The harness reports its own quota on this stream. Reading it here
            // costs nothing and refreshes on every turn, which is what keeps the
            // shared OAuth usage endpoint -- a per-account budget several open
            // chats used to exhaust between them -- down to a cold-start probe.
            // (Self-gated on a substring, so it does not re-parse ordinary lines.)
            void recordNativeStreamUsage(session, lineText).catch(() => undefined);
            const reported = outcome.selfReport;
            if (reported?.model || reported?.permissionMode) {
              session.reported = {
                at: new Date().toISOString(),
                ...(reported.model ? { model: reported.model } : {}),
                ...(reported.permissionMode ? { permissionMode: reported.permissionMode } : {}),
              };
              checkpoint.touch();
              prompter?.render(session);
            }
          },
        });
        if (turnOutput.interrupted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
        const cliResult = nativeTurnResult(cliHarness, turnOutput.stdout);
        if (!cliResult.isError) confirmNativeSession();
        noteUsage(cliResult.usage ?? nativeTurnUsage(cliHarness, turnOutput.stdout));
        return cliResult;
      };
      try {
        if (transport === 'structured-cli' || transport === 'text-cli') {
          result = await runStructuredCliTurn();
        } else {
          // ACP and the app-server own session identity: never hand them an id
          // ClikCode minted for a CLI attempt that the vendor never confirmed.
          if (session.nativeSessionPreallocated) {
            session.nativeSessionId = undefined;
            delete session.nativeSessionPreallocated;
          }
          const persistent = run.persistentTransports
            ? persistentTransportFor(session.id, transport, JSON.stringify([harness.command, account.id, environment, session.workspace]))
            : undefined;
          try {
            if (transport === 'codex-app-server') {
              const overrides = appServerThreadOverrides(declaredOptions, session.harnessOptions);
              if (overrides.unmapped.length) prompter?.activity(chalk.dim(`${harness.displayName} app-server ignores: ${overrides.unmapped.join(', ')}`));
              const codexInput: CodexAppServerTurnInput = {
                binary: harness.binary, prompt: turnText, nativeSessionId: session.nativeSessionId,
                cwd: session.workspace!, model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask',
                images, environment, signal, onSessionId,
                ...(overrides.configOverrides ? { configOverrides: overrides.configOverrides } : {}),
                ...(overrides.extraThreadParams ? { extraThreadParams: overrides.extraThreadParams } : {}),
                // Codex reports its own quota on this connection during the turn,
                // which is the same figure codexUsageProbe otherwise spawns a whole
                // second app-server to ask for.
                onRateLimits: (rateLimits) => {
                  // The structured reading (not just its label) so the windows'
                  // resetsAt survives into account.usage for the reset-time line.
                  void recordDerivedUsage(session, codexRateLimitsReading(rateLimits)).catch(() => undefined);
                },
                ...sharedObserver,
                // Steering is genuinely codex-only: it is the one transport
                // that accepts input mid-turn.
                onSteerReady: (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText) => {
                  await handler(steerText);
                  await checkpoint.steer({ id: randomUUID(), text: steerText, submittedAt: new Date().toISOString() });
                } : undefined),
              };
              result = persistent ? await (persistent.session as CodexSession).runTurn(codexInput) : await runCodexAppServerTurn(codexInput);
            } else {
              const launch = harnessAcpLaunch(harness, { model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask' });
              if (!launch) throw new Error(`${harness.displayName} does not declare an ACP launch`);
              const acpInput: AcpTurnInput = {
                binary: launch.binary, command: harness.command, prompt: turnText,
                argv: launch.modeArgv, optionPlacement: launch.optionPlacement,
                extraArgv: [...launch.optionArgv, ...declaredOptionArgv(declaredOptions, session.harnessOptions, Boolean(session.nativeSessionId))],
                ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId, sessionCreated: true } : {}),
                cwd: session.workspace!, model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask',
                environment, signal, images, onSessionId,
                ...sharedObserver,
              };
              try {
                result = persistent ? await (persistent.session as AcpSession).runTurn(acpInput) : await runAcpTurn(acpInput);
              } catch (error) {
                if (!(error as Error & { acpSafeToFallback?: boolean }).acpSafeToFallback || !harness.turn) throw error;
                prompter?.phase('using structured CLI fallback');
                result = await runStructuredCliTurn();
              }
            }
          } catch (error) {
            // After a failed turn the child's protocol state is unknown.
            if (persistent) await closePersistentTransport(session.id);
            throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError') throw error;
        if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_TOO_LARGE') throw error;
        caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
      }
      result = caughtTurnFailure
        ? { isError: true, text: caughtTurnFailure.message }
        : result!;
      if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
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
        // An `experimental` structured contract an older vendor build rejects
        // outright: retry once on the proven fallback contract, and remember it.
        if (failureKind === 'other' && !cliOutputStarted && harness.experimental && harness.fallbackTurn
          && !fallbackTurnHarnesses.has(harness.command) && (transport === 'structured-cli' || transport === 'text-cli')) {
          fallbackTurnHarnesses.add(harness.command);
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
          if (!authRetried && prompter && harness.loginArgv) {
            authRetried = true;
            await closePersistentTransport(session.id);
            if (harness.loginCapturable) {
              prompter.startWaiting(`signing in to ${harness.displayName}…`);
              try { await loginNativeHarness(harness, environment); } finally { prompter.stopWaiting(); }
            } else {
              prompter.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
              await prompter.suspend();
              try {
                await loginNativeHarness(harness, environment);
              } finally {
                prompter.resume();
              }
            }
            account = await syncAccountIdentityAfterLogin(harness, account, state);
            session.accountId = account.id;
            continue;
          }
        }
        if (failureKind === 'native-thread-invalid') {
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
          session.nativeSessionId = undefined;
          session.nativeStartedAt = undefined;
          delete session.nativeSessionPreallocated;
          turnText = interruptedTurnFailoverPrompt(session);
          checkpoint.response('', 'replace');
          prompter?.response('', 'replace');
          continue;
        }
        // A rejected REQUEST is not an account problem, and trying the next
        // account cannot fix it -- the same argv gets refused identically
        // every time. This is exactly what made a single bad flag look like
        // "every account failed": ClikCode sent --effort to Antigravity,
        // which encodes effort in the model id, and then walked all seven
        // accounts collecting the same refusal, paying a 60-second
        // interactive-auth timeout on the one that was not signed in.
        // Surface the vendor's own complaint instead, which names the
        // problem.
        if (failureKind === 'request-invalid') throw failure;
        // Failover is about finding an account that can still work, so it is
        // not gated on the failure being a quota refusal. A turn that died
        // for any other reason still moves to the next account that has usage
        // -- bounded by attemptedAccounts, so each is tried at most once and a
        // genuinely broken harness cannot cycle forever.
        //
        // Only a quota refusal marks the account spent, though: a crash says
        // nothing about how much allowance is left.
        if (failureKind === 'quota-exhausted') {
          account.quotaState = 'exhausted';
          account.quotaRetryAt = undefined;
          exhaustedAnyAccount = true;
          // The one observation that makes a learned limit possible: this much
          // was refused. Only recorded for a real quota refusal -- a crash
          // says nothing about where the ceiling is.
          account.usageLearning = recordRefused(account.usageLearning, state.invocations, account.id, Date.now());
        }
        attemptedAccounts.add(account.id);
        await checkpoint.persistNow();
        // Same-provider failover for the native-CLI path: switching accounts means
        // switching vendor config roots, so the in-flight native conversation can't
        // continue under the old identity — start a fresh one under the fallback.
        // Running out reads the same whether or not failover is on. With it
        // off there is simply nowhere to switch to, which is the same outcome
        // as having switched everywhere and found nothing -- so it says the
        // same thing rather than leaking whatever the vendor happened to call
        // it ("Payment Required", "usage balance exhausted").
        if (session.accountFailover !== 'on-quota-exhausted') {
          if (!exhaustedAnyAccount) throw failure;
          throw new Error(usageExhaustedMessage(account ? [account] : []));
        }
        const fallback = await nextUsableFailoverAccount(
          state, account, (item) => item.authKind === 'vendor-cli', attemptedAccounts,
        );
        if (!fallback) {
          await checkpoint.persistNow();
          // Nothing left to try. "Usage Exhausted" only if running out is
          // actually what happened -- if the last account died of something
          // else, saying it ran out would be inventing a reason.
          if (!exhaustedAnyAccount) throw failure;
          throw new Error(usageExhaustedMessage(
            state.accounts.filter((item) => attemptedAccounts.has(item.id) || item.id === account?.id),
          ));
        }
        // The vendor's own thread is carried into the account taking over, so
        // it resumes with everything it actually said and did rather than a
        // retelling of it. Only where that cannot be done -- a harness whose
        // transcript layout is not known, a file that is not on disk -- does
        // the turn fall back to a fresh thread seeded from ClikCode's copy.
        const carriedThread = await carryNativeSession({
          harness,
          nativeId: session.nativeSessionId,
          workspace: session.workspace,
          from: turnEnvironment(harness, account),
          to: turnEnvironment(harness, fallback),
        });
        switchedFrom = account.label;
        // Announced before the retry, not after it returns: switching accounts
        // happens inside one continuous await chain, so without this the whole
        // thing looks instantaneous and the reply just silently comes from a
        // different account with nothing to explain the (brief) extra wait.
        // Say why it moved. Switching happens for any failure now, so calling
        // every one of them "quota reached" would misreport a crash as a
        // spent plan.
        prompter?.activity(`${chalk.yellow(accountFailureReason(failureKind))} ${chalk.dim(`${switchedFrom} → ${fallback.label}, retrying…`)}`);
        prompter?.phase(`retrying on ${fallback.label}`);
        await closePersistentTransport(session.id);
        account = fallback;
        session.accountId = fallback.id;
        if (carriedThread) {
          // The same thread, under a new account: it holds the conversation,
          // the interrupted request and every tool call it had already made.
          // All it is owed is the word to carry on.
          //
          // 'present' counts here as much as 'carried'. It means the thread
          // never had to move, because both accounts run this harness against
          // the same vendor home -- true for the fifteen harnesses that
          // declare no profileEnv at all. Those were re-seeding the whole
          // conversation to reach a file sitting exactly where the next
          // account would look for it, which is the difference between a
          // failover costing a 20KB prompt and costing nothing.
          turnText = INTERRUPTED_TURN_REQUEST;
        } else {
          session.nativeSessionId = undefined;
          session.nativeStartedAt = undefined;
          delete session.nativeSessionPreallocated;
          // Built while the interrupted attempt's touched-file hints are still
          // on the checkpoint; only then is the partial response cleared,
          // because the retry is a new response attempt (the direct-API path
          // does the same).
          turnText = interruptedTurnFailoverPrompt(session);
        }
        checkpoint.response('', 'replace');
        prompter?.response('', 'replace');
        continue;
      }
      session.nativeStartedAt ??= new Date().toISOString();
      delete session.nativeSessionPreallocated;
      const usage = addTurnUsage(carriedPendingUsage, turnUsage as NormalizedTurnUsage | undefined);
      const invocation = {
        id: randomUUID(), accountId: account.id, provider: harness.provider, ...(model ? { model } : {}),
        at: new Date().toISOString(), sessionId: session.id,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        latencyMs: Date.now() - startedAt,
      };
      state.invocations.push(invocation);
      // An allowed turn raises this account's learned ceiling. Recorded after
      // the invocation is pushed so the window sum includes this turn: the
      // high-water mark must be a cost the vendor actually permitted.
      account.usageLearning = recordAllowed(account.usageLearning, state.invocations, account.id, Date.parse(invocation.at));
      // A turn that was served is proof the account is not out of quota.
      // Nothing else cleared this for most harnesses: the only other
      // clearers are a manual /account reselect and a usage PROBE reporting
      // headroom, and twenty-one of the twenty-four harnesses have no probe.
      // So an account marked exhausted stayed exhausted forever -- found
      // live, with two accounts answering normally while still flagged,
      // which deprioritised them in failover and slowly starved it of
      // candidates.
      if (account.quotaState === 'exhausted') {
        account.quotaState = 'available';
        account.quotaRetryAt = undefined;
      }
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
      session.attachments = [];
      const answer = titleStream ? extractSessionTitle(result.text) : { title: undefined, text: result.text };
      await checkpoint.complete(answer.text);
      await nameSession(session, {
        title: titleStream?.title ?? answer.title,
        ...(titleSource === 'vendor'
          ? { vendor: () => nativeGeneratedTitle(harness, session.nativeSessionId, session.workspace, environment) }
          : {}),
      });
      // The vendor subprocess owns persistence. Re-read its transcript after
      // exit so any source-side turns/events that were not represented by the
      // final response are reflected in ClikCode before the turn is saved.
      await synchronizeNativeTranscript(state, session);
      await writeState(state);
      if (!prompter) emitHarnessOutput({ session, text: answer.text, usage: { attributedBy: harness.command, ...usage }, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
      return;
    }
    } finally {
      await checkpoint.flush();
    }
  }

  if (prepared.images.length) throw new Error('Image attachments need a vendor harness that accepts images; direct API-key accounts do not. Switch providers with /provider or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const baseMessages = sessionTranscriptMessages(session);
  // No harness on this path writes its own titles, so the first turns of a
  // conversation ask the model for one and the answer is stripped of it.
  const titleStream = shouldRequestTitle(session) ? new StreamingTitle() : undefined;
  if (titleStream) {
    turnText = withTitleRequest(turnText);
    session.titleAttempts = (session.titleAttempts ?? 0) + 1;
  }
  const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
  run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => checkpoint.unqueueSoon(submission));
  let switchedFrom: string | undefined;
  const attemptedAccounts = new Set<string>();
  try {
  if (session.accountFailover === 'on-quota-exhausted' && account.quotaState === 'exhausted') {
    attemptedAccounts.add(account.id);
    const fallback = await nextUsableFailoverAccount(
      state, account, (item) => item.authKind === 'api-key' && item.models.includes(model), attemptedAccounts,
    );
    if (!fallback) {
      await writeState(state);
      throw new Error(usageExhaustedMessage(
          state.accounts.filter((item) => attemptedAccounts.has(item.id) || item.id === account?.id),
        ));
    }
    switchedFrom = account.id;
    prompter?.activity(`${chalk.yellow('quota exhausted')} ${chalk.dim(`${account.label} → ${fallback.label}`)}`);
    prompter?.phase(`switching to ${fallback.label}`);
    account = fallback;
    session.accountId = fallback.id;
    await checkpoint.persistNow();
  }
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt. Clear any partial text from the
    // exhausted account, then append each real provider delta directly to the
    // checkpoint/UI. The router has always exposed onDelta;
    // omitting it here was why direct-API responses appeared only at the end.
    checkpoint.response('', 'replace');
    prompter?.response('', 'replace');
    return streamLocalAiTurn({
      provider: session.provider ?? active.provider, model, apiKey: localApiKey(active), credentialSource: 'env',
      messages: [...baseMessages, { role: 'user', content: turnText }], reasoningEffort: session.effort as never,
      ...(signal ? { abortSignal: signal } : {}),
      onDelta: (delta: string) => {
        const visible = titleStream ? titleStream.push(delta, 'append') : delta;
        if (visible === undefined) return;
        checkpoint.response(visible, 'append');
        prompter?.response(visible, 'append');
      },
    });
  };
  let turn: Awaited<ReturnType<typeof streamLocalAiTurn>>;
  /** Whether any account here actually ran out, as opposed to failing some
   * other way -- decides whether "Usage Exhausted" is the truth at the end. */
  let exhaustedAnyApiAccount = false;
  for (;;) {
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      const failureKind = classifyAccountFailure(error);
      if (failureKind === 'authentication-required') {
        account.status = 'needs_login';
        await writeState(state);
      }
      // Same rules as the vendor-CLI path above, both of them: a rejected
      // request is not an account problem and no other account will accept
      // it either, so surface it rather than walking the list; otherwise move
      // to the next account that has usage whatever went wrong, and only call
      // an account spent when it actually refused for quota.
      if (failureKind === 'request-invalid') throw error;
      if (session.accountFailover !== 'on-quota-exhausted') throw error;
      const exhaustedAccount = account;
      if (failureKind === 'quota-exhausted') {
        exhaustedAccount.quotaState = 'exhausted';
        exhaustedAccount.quotaRetryAt = undefined;
        exhaustedAnyApiAccount = true;
        exhaustedAccount.usageLearning = recordRefused(exhaustedAccount.usageLearning, state.invocations, exhaustedAccount.id, Date.now());
      }
      attemptedAccounts.add(exhaustedAccount.id);
      // Preserve every failed candidate before looking for the next one. A
      // chain of stale account records therefore terminates instead of merely
      // moving the same failure to one alternate and abandoning the router.
      await writeState(state);
      const fallback = await nextUsableFailoverAccount(
        state, exhaustedAccount,
        (item) => item.authKind === 'api-key' && item.models.includes(model),
        attemptedAccounts,
      );
      if (!fallback) {
        await writeState(state);
        if (!exhaustedAnyApiAccount) throw error;
        throw new Error(usageExhaustedMessage(
          state.accounts.filter((item) => attemptedAccounts.has(item.id) || item.id === account?.id),
        ));
      }
      switchedFrom ??= exhaustedAccount.id;
      prompter?.activity(`${chalk.yellow(accountFailureReason(failureKind))} ${chalk.dim(`${exhaustedAccount.label} → ${fallback.label}, retrying…`)}`);
      prompter?.phase(`retrying on ${fallback.label}`);
      account = fallback;
      session.accountId = fallback.id;
    }
  }
  const invocation = {
    id: randomUUID(), sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model,
    at: new Date().toISOString(), inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt,
  };
  if (prompter && Array.isArray(turn.toolCalls)) {
    for (const call of turn.toolCalls) {
      const name = call && typeof call.name === 'string' ? call.name : 'tool';
      // The tool's own name, with nothing in front of it -- the same rule the
      // native-harness rows follow. This is the Gateway/direct-API path, and
      // it was the one place still prepending a status word.
      prompter.activity(chalk.dim(name));
    }
  }
  state.invocations.push(invocation);
  // Same as the vendor-CLI path: an allowed turn raises the learned ceiling.
  account.usageLearning = recordAllowed(account.usageLearning, state.invocations, account.id, Date.parse(invocation.at));
  // Same proof-by-success rule as the vendor-CLI path above.
  if (account.quotaState === 'exhausted') {
    account.quotaState = 'available';
    account.quotaRetryAt = undefined;
  }
  session.attachments = [];
  const answer = titleStream ? extractSessionTitle(turn.text) : { title: undefined, text: turn.text };
  await checkpoint.complete(answer.text);
  await nameSession(session, { title: titleStream?.title ?? answer.title });
  if (!prompter) emitHarnessOutput({ session, text: answer.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
  } finally {
    await checkpoint.flush();
  }
}

/** What the Gateway's final `result` event says that the text did not. */
function gatewayResultNotice(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const result = data as { requiresConfirmation?: unknown; pendingToolCalls?: unknown };
  const pending = Array.isArray(result.pendingToolCalls) ? result.pendingToolCalls : [];
  if (result.requiresConfirmation !== true && pending.length === 0) return undefined;
  const names = pending.map((call) => {
    const record = call && typeof call === 'object' ? call as { name?: unknown; tool?: unknown; toolName?: unknown } : {};
    return [record.name, record.tool, record.toolName].find((value): value is string => typeof value === 'string');
  }).filter((name): name is string => Boolean(name));
  const what = pending.length ? `${pending.length} action${pending.length === 1 ? '' : 's'}${names.length ? ` (${[...new Set(names)].slice(0, 5).join(', ')})` : ''}` : 'an action';
  return `The platform is holding ${what} for your confirmation and has NOT run ${pending.length === 1 || !pending.length ? 'it' : 'them'}. ClikCode cannot confirm Gateway actions yet — approve ${pending.length === 1 || !pending.length ? 'it' : 'them'} in the ClikDeploy dashboard assistant.`;
}

/** Send a gateway session through the existing authenticated platform assistant stream. */
export async function aiGatewaySessionSend(
  config: Conf, id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const prompter = run.prompter;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route !== 'gateway') return aiSessionSend(id, prompt, signal, run);
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  if (prepared.images.length) throw new Error('ClikDeploy Gateway does not accept image attachments. Switch to a local provider with /provider or clear them with /attachments clear.');
  // The first turns of a conversation carry the title request here too: the
  // gateway's coding agent and the platform assistant both answer as a
  // model, and neither writes a title of its own anywhere ClikCode can read.
  const titleStream = shouldRequestTitle(session) ? new StreamingTitle() : undefined;
  const turnText = titleStream ? withTitleRequest(`${text}${prepared.textContext}`) : `${text}${prepared.textContext}`;
  if (titleStream) session.titleAttempts = (session.titleAttempts ?? 0) + 1;
  const baseUrl = getApiUrl(config).replace(/\/$/, '');
  const apiKey = getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  const startedAt = Date.now();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await DurableTurnCheckpoint.start(state, session, text, run.queuedTurnId);
  // The coding agent runs here, on this machine; the gateway supplies the
  // model step and nothing else. Only a gateway that cannot serve that -- an
  // administrator kill switch, or a deployment older than the endpoint --
  // falls back to the platform assistant below, and says so when it does.
  try {
    const harnessTurn = await runGatewayHarnessSessionTurn({
      session, prompt: turnText, baseUrl, apiKey, version: CLIKCODE_VERSION,
      ...(prompter ? { prompter } : {}),
      ...(signal ? { signal } : {}),
      ...(prepared.images.length ? { images: prepared.images } : {}),
      onActivity: (event) => checkpoint.activity(event),
    });
    if (harnessTurn.isError) throw new Error(harnessTurn.text || 'gateway harness turn failed');
    const harnessInvocation = {
      id: randomUUID(), sessionId: session.id, accountId: 'gateway',
      provider: session.provider ?? 'clikdeploy-gateway', ...(session.model ? { model: session.model } : {}),
      at: new Date().toISOString(), latencyMs: Date.now() - startedAt,
    };
    state.invocations.push(harnessInvocation);
    session.attachments = [];
    const named = titleStream ? extractSessionTitle(harnessTurn.text) : { title: undefined, text: harnessTurn.text };
    await checkpoint.complete(named.text);
    await nameSession(session, { title: titleStream?.title ?? named.title });
    if (!prompter) {
      emitHarnessOutput({
        session, text: named.text, usage: { attributedBy: 'clikdeploy-gateway' }, invocation: harnessInvocation,
      });
    }
    await checkpoint.flush();
    return;
  } catch (error) {
    if (!gatewayHarnessUnavailable(error)) { await checkpoint.flush(); throw error; }
    const notice = gatewayHarnessFallbackNotice(error);
    if (prompter) prompter.activity(chalk.dim(notice));
    else if (!isJsonDefaultMode()) output.write(`${chalk.yellow('Gateway:')} ${notice}\n`);
  }
  run.liveInput?.bindQueue((submission) => checkpoint.queue(submission));
    run.liveInput?.setLateSteerHandler((submission) => checkpoint.unqueueSoon(submission));
  try {
  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify({ message: turnText, messages: baseMessages, mode: 'plan' }),
  });
  if (!response.ok || !response.body) throw new Error(`gateway AI request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let gatewayNotice: string | undefined;
  const streamToTerminal = !isJsonDefaultMode() && !prompter;
  let wroteDelta = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; label?: string; kind?: 'thinking' | 'tool-start'; tool?: string; data?: unknown };
        // The server's final `result` carries what the text stream cannot:
        // tool calls it is holding back for confirmation. Dropping it left
        // the user with a reply that implied work the platform never did.
        if (event.type === 'result') gatewayNotice = gatewayResultNotice(event.data) ?? gatewayNotice;
        if (event.type === 'delta' && typeof event.text === 'string') {
          reply += event.text;
          const visible = titleStream ? titleStream.push(event.text, 'append') : event.text;
          if (visible !== undefined) {
            checkpoint.response(visible, 'append');
            prompter?.phase('generating response');
            prompter?.response(visible, 'append');
            if (streamToTerminal) { output.write(visible); wroteDelta = true; }
          }
        }
        // `kind`/`tool` are real, additive fields on the wire protocol
        // (apps/web's chat-stream.ts / assistant/chat route) mapping the
        // backend's own `{ status: 'thinking' }` / `{ status: 'tool_call',
        // tool }` into the same canonical shape native harnesses' own
        // parsers produce, so a Gateway tool call's *activity log line*
        // renders identically to a Codex or Claude Code one — same glyph,
        // same color, same bare-subject wording (renderActivityLine adds its
        // own verb, so the canonical label here is the bare tool name via
        // `tool`, not the backend's already-verbed `label`). The phase
        // (spinner text) uses `label` directly instead, since the backend's
        // phrasing ("Restarting the app…") is already the ideal spinner
        // text and the terminal lifecycle's own "running X" wording is for
        // bare native-harness tool names, not a pre-verbed phrase. There's
        // no 'tool-done' here because AssistantChatEvent has no completion
        // signal to report (verified: 'tool_call' fires once, nothing after
        // it) — a real gap in what the agent loop reports, not something to
        // fake here.
        if (event.type === 'status' && typeof event.label === 'string') {
          const activityEvent: HarnessActivityEvent = { kind: event.kind === 'tool-start' ? 'tool-start' : 'thinking', label: event.tool ?? event.label };
          checkpoint.activity(activityEvent);
          if (prompter) {
            prompter.activityEvent(activityEvent);
            // Gateway labels are already humanized (for example,
            // "Restarting the app…"). Apply that richer label after the
            // generic lifecycle updates active-tool tracking.
            prompter.phase(event.label);
          }
          else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(activityEvent)) output.write(`${activity}\n`);
        }
        if (event.type === 'error') throw new Error(event.error ?? 'gateway AI request failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (gatewayNotice) {
    if (prompter) prompter.activity(`${chalk.yellow('gateway')} ${chalk.dim(gatewayNotice)}`);
    else if (!isJsonDefaultMode()) output.write(`${wroteDelta ? '\n' : ''}${chalk.yellow('Gateway:')} ${gatewayNotice}\n`);
    if (!reply) reply = gatewayNotice;
  }
  if (!reply) throw new Error('gateway AI response contained no text');
  const invocation = { id: randomUUID(), sessionId: session.id, accountId: 'gateway', provider: session.provider ?? 'clikdeploy-gateway', ...(session.model ? { model: session.model } : {}), at: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  state.invocations.push(invocation);
  session.attachments = [];
  const answered = titleStream ? extractSessionTitle(reply) : { title: undefined, text: reply };
  await checkpoint.complete(answered.text);
  await nameSession(session, { title: titleStream?.title ?? answered.title });
  if (wroteDelta) output.write('\n\n');
  else if (!prompter) emitHarnessOutput({ session, text: answered.text, usage: { attributedBy: 'clikdeploy-gateway' }, invocation, ...(gatewayNotice ? { notice: gatewayNotice } : {}) });
  } finally {
    await checkpoint.flush();
  }
}
