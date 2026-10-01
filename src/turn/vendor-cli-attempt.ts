/** One structured CLI attempt, including its native session and background process. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import chalk from 'chalk';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { HarnessSession } from '../session/model.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import { nativeTurnResult } from '../harness/protocol/turn-result.js';
import { parseJsonRecord } from '../harness/protocol/json-lines.js';
import { aiderHistoryNotice, aiderHistoryReply, aiderStdoutReply } from '../harness/events/aider.js';
import { createStreamState } from '../harness/events/adapters.js';
import { reportStructuredLine } from '../harness/events/structured.js';
import { captureNativeHarness } from '../harness/transport/native/command.js';
import { captureNativeHarnessTurn, createTurnIdleController, createTurnInput, createTurnRelease, noteTurnActivityEvent } from '../harness/transport/native/turn.js';
import { createBackgroundWait, streamJsonUserMessage } from '../harness/transport/native/background-wait.js';
import { hasHeldVendorProcess, holdVendorProcess, releaseHeldVendorProcess, type HeldVendor } from '../harness/transport/native/held-vendor.js';
import { vendorBackgroundEvent } from '../harness/transport/native/background-task.js';
import { recordNativeStreamUsage } from '../harness/accounts/stream-usage.js';
import { harnessStatePath } from '../session/state/paths.js';
import { maxPromptArgvBytes, nativeHarnessTurnArgv, promptExceedsArgvLimit } from '../runtime/lazy-bridge.js';
import { usesFallbackTurn, vendorBackgroundTurnHandlerFor } from './vendor-process.js';
import { turnCancelledError } from '../agent/cancellation.js';

/** With no session worker to show a background turn, let finished turns wait
 * briefly on their still-running background tasks. */
const UNHELD_BACKGROUND_GRACE_MS = 60_000;

function insideGitRepository(folder: string): boolean {
  for (let directory = resolve(folder); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return true;
    if (dirname(directory) === directory) return false;
  }
}

export async function runVendorCliAttempt(input: {
  harness: AiLocalHarnessDefinition;
  session: HarnessSession;
  turnText: string;
  model: string | null;
  environment: Record<string, string>;
  images: string[];
  signal?: AbortSignal;
  run: TurnRunOptions;
  checkpoint: DurableTurnCheckpoint;
  effort?: string;
  sharedObserver: HarnessTurnObserver;
  onOutputStart: () => void;
  onStreamError: (error: { message: string; statusCode?: number; kind?: string }) => void;
}): Promise<NativeTurnResult> {
  const { harness, session, turnText, model, environment, images, signal, run, checkpoint, effort, sharedObserver, onOutputStart, onStreamError } = input;
  const prompter = run.prompter;
  let turnOutput: Awaited<ReturnType<typeof captureNativeHarnessTurn>> = { stdout: '', stderr: '', exitCode: 0 };
  // A previous turn's vendor may still be running for its background
  // work (held-vendor.ts). This turn takes over: stdin closes, anything
  // it was saying finishes into its own transcript, and it exits.
  if (hasHeldVendorProcess(session.id)) {
    prompter?.phase('closing background work');
    await releaseHeldVendorProcess(session.id);
  }
  const cliHarness: AiLocalHarnessDefinition = harness.fallbackTurn && await usesFallbackTurn(harness)
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
    launchedBefore: Boolean(session.nativeStartedAt), model, workspace: session.workspace, effort,
    permissionMode: session.permissionMode ?? 'ask', images, options: session.harnessOptions,
  });
  if (turn.outsideRepoArgv && !insideGitRepository(session.workspace ?? process.cwd())) argv.unshift(...turn.outsideRepoArgv);
  // Persist an allocated native identity before the provider starts so an
  // interrupted turn cannot accidentally fork the centralized conversation.
  if (createdHere) await checkpoint.persistNow();
  const confirmNativeSession = (): void => {
    if (!session.nativeSessionPreallocated) return;
    delete session.nativeSessionPreallocated;
    checkpoint.touch();
  };
  const idle = createTurnIdleController();
  // One stream position per attempt: a retry is a new response, and
  // a vendor's per-record session ids must not decide which records
  // belong together (see adapters.ts StreamState).
  const stream = createStreamState();
  /** Usage already reached the observer line by line, the moment each record
   * arrived. Only a harness whose output is one document at exit (or text)
   * leaves it to be read afterwards. */
  let sawLineUsage = false;
  // A stream-json stdin stays open while the vendor has background work
  // running, so the turn it starts when that work finishes reaches this
  // conversation instead of being killed at exit (background-wait.ts).
  // A message typed while this turn runs goes straight to the vendor.
  const vendorBackground = new Set<string>();
  const heldInput = turn.promptInput === 'stdin' && turn.stdinFormat === 'stream-json' ? createTurnInput() : undefined;
  // A successful answer with background tasks still running ends this
  // turn at once; the process is kept, and what it says when a task
  // finishes becomes a background turn (held-vendor.ts). With nobody to
  // show that (no session worker), the turn waits a bounded while
  // instead, then lets the tasks go.
  const backgroundHandler = heldInput ? vendorBackgroundTurnHandlerFor(session.id) : undefined;
  const release = backgroundHandler ? createTurnRelease() : undefined;
  let held: HeldVendor | undefined;
  const heldStreams = new WeakMap<object, ReturnType<typeof createStreamState>>();
  const background = heldInput ? createBackgroundWait({
    onSettled: () => {
      run.liveInput?.setSteerHandler(undefined);
      heldInput.end();
    },
    onQuiet: () => held?.quiet(),
    onTaskStarted: (id, description) => {
      idle.toolStarted(`background:${id}`);
      if (!held) prompter?.activity(chalk.dim(`background: ${description}`));
    },
    onTaskFinished: (id, status) => {
      idle.toolFinished(`background:${id}`);
      if (!held) prompter?.activity(chalk.dim(`background task ${status}`));
    },
    ...(backgroundHandler ? {} : { resultGraceMs: UNHELD_BACKGROUND_GRACE_MS }),
  }) : undefined;
  if (heldInput && background) {
    run.liveInput?.setSteerHandler(async (steerText, submission) => {
      if (background.settled || !heldInput.write(streamJsonUserMessage(steerText))) throw new Error('turn is finishing');
      background.noteInput();
      await checkpoint.steer(submission);
    });
  }
  try {
    turnOutput = await captureNativeHarnessTurn(cliHarness, argv, environment, {
    cwd: session.workspace,
    signal,
    idleController: idle,
    stdinText: turn.promptInput === 'stdin' ? (heldInput ? streamJsonUserMessage(turnText) : turnText) : undefined,
    ...(heldInput ? { input: heldInput } : {}),
    ...(release ? { release } : {}),
    onStdoutLine: (lineText) => {
      // Parsed here, once: every reader below takes this record.
      const record = parseJsonRecord(lineText);
      if (held) {
        held.line(lineText, record);
        void recordNativeStreamUsage(session, lineText).catch(() => undefined);
        return;
      }
      if (background && record) background.note(record);
      else if (record && /"task_notification"|"isBackground":true/.test(lineText)) {
        // A vendor that waits for its own background work in-process
        // (Cursor) is silent meanwhile: that silence gets the running-tool
        // budget, not the ordinary one. See background-task.ts.
        const event = vendorBackgroundEvent(record);
        if (event?.kind === 'started' && !vendorBackground.has(event.id)) {
          vendorBackground.add(event.id);
          idle.toolStarted(`background:${event.id}`);
        } else if (event?.kind === 'finished' && vendorBackground.delete(event.id)) idle.toolFinished(`background:${event.id}`);
      }
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
          onOutputStart();
          idle.noteActivity();
          sharedObserver.onResponseDelta?.(text, mode ?? 'append');
        },
        onActivity: (event) => {
          onOutputStart();
          noteTurnActivityEvent(idle, event);
          sharedObserver.onActivity?.(event);
        },
      }, stream, record);
      if (outcome.usage) sawLineUsage = true;
      if (outcome.live) confirmNativeSession();
      if (outcome.error) onStreamError(outcome.error);
      if (outcome.result) idle.noteResult(outcome.result);
      // Answered, and only background tasks left: the turn is over.
      if (outcome.result === 'success' && release && background && backgroundHandler
        && background.pending > 0 && background.quiet && !background.settled) {
        run.liveInput?.setSteerHandler(undefined);
        held = holdVendorProcess({
          sessionId: session.id, background, release, handler: backgroundHandler,
          endInput: () => heldInput!.end(),
          // One stream position per background turn, like per attempt.
          report: (text, observer, parsed) => {
            let position = heldStreams.get(observer);
            if (!position) heldStreams.set(observer, position = createStreamState());
            reportStructuredLine(cliHarness, text, observer, position, parsed);
          },
        });
      }
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
  } finally {
    // Whatever ended the process, input to it has nowhere to go now --
    // unless it was handed on still running.
    if (background && !held) {
      background.dispose();
      run.liveInput?.setSteerHandler(undefined);
    }
  }
  if (turnOutput.interrupted) throw turnCancelledError();
  let cliResult = nativeTurnResult(cliHarness, turnOutput.stdout, { exitCode: turnOutput.exitCode, stderr: turnOutput.stderr });
  // Aider's stdout is its banner, the answer and a cost footer; its own
  // chat history file holds the answer alone (see events/aider.ts).
  // When that file exists it alone decides: a turn with no reply in it
  // failed, and the notice Aider quoted there says why. Stdout is only
  // read when there is no file, since there the error sits where an
  // answer would.
  if (cliHarness.parser === 'aider') {
    const history = session.nativeSessionId ? await readFile(session.nativeSessionId, 'utf8').catch(() => '') : '';
    const reply = history ? aiderHistoryReply(history) : aiderStdoutReply(turnOutput.stdout);
    if (!reply) {
      const notice = history ? aiderHistoryNotice(history) : undefined;
      throw Object.assign(new Error(`${cliHarness.displayName}: ${notice ?? 'returned no reply'}`), {
        stderrTail: [notice, turnOutput.stderr.trim()].filter(Boolean).join('\n').slice(-4000),
        stdoutTail: turnOutput.stdout.trim().slice(-4000),
      });
    }
    cliResult = { ...cliResult, text: reply };
  }
  if (!cliResult.isError) confirmNativeSession();
  if (!sawLineUsage && cliResult.usage) sharedObserver.onUsage?.(cliResult.usage);
  return cliResult;
}
