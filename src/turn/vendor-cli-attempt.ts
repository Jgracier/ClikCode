/** One structured CLI attempt, including its native session and background process. */
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { HarnessSession } from '../session/model.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import { nativeTurnResult } from '../harness/protocol/turn-result.js';
import { parseJsonRecord } from '../harness/protocol/json-lines.js';
import { ProcessCost } from '../harness/protocol/running-cost.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { aiderHistoryNotice, aiderHistoryReply, aiderStdoutReply } from '../harness/events/aider.js';
import { createStreamState } from '../harness/events/adapters.js';
import { reportStructuredLine } from '../harness/events/structured.js';
import { captureNativeHarness } from '../harness/transport/native/command.js';
import { captureNativeHarnessTurn, createTurnInput, createTurnRelease } from '../harness/transport/native/turn.js';
import { nativeMcpConfig } from '../harness/transport/native/mcp-config.js';
import { createBackgroundWait, streamJsonUserMessage } from '../harness/transport/native/background-wait.js';
import { createPiRpcTurn, piRpcPrompt, piRpcSteer } from '../harness/transport/native/pi-rpc.js';
import { ampUserMessage, createAmpStreamTurn } from '../harness/transport/native/amp-stream.js';
import { settleHeldVendor } from './turn-steps.js';
import { holdVendorProcess, type HeldVendor } from '../harness/transport/native/held-vendor.js';
import { recordNativeStreamUsage } from '../harness/accounts/stream-usage.js';
import { stateDirectory } from '../session/store/paths.js';
import { maxPromptArgvBytes, nativeHarnessTurnArgv, promptExceedsArgvLimit } from '../runtime/lazy-bridge.js';
import { reportEndedWork, vendorBackgroundTurnHandlerFor } from './vendor-process.js';
import { turnCancelledError } from '../agent/cancellation.js';
import { turnPermissionMode } from './turn-permission.js';

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
  // A previous turn's vendor may still be running background work. On this account its
  // Agent calls and follow-up finish before closing stdin (Claude kills running Agent calls
  // when that input closes); a process the conversation left is retired, not waited on.
  await settleHeldVendor(session.id, prompter, signal);
  const turn = harness.turn;
  if (!turn) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
  if (promptExceedsArgvLimit(harness, turnText)) {
    throw Object.assign(new Error(
      `${harness.displayName} takes its prompt as a command-line argument, and this request is ${Math.ceil(Buffer.byteLength(turnText, 'utf8') / 1024)} KB (limit ${Math.floor(maxPromptArgvBytes() / 1024)} KB). Shorten it, or save the long content to a file in the workspace and ask the agent to read it.`,
    ), { code: 'ERR_PROMPT_TOO_LARGE' });
  }
  // Only a structured-CLI harness gets an id minted here, and it stays
  // marked "preallocated" until the vendor process is seen to own it:
  // a first attempt that dies early must re-create, never `--resume` an
  // id that was never created.
  let createdHere = Boolean(session.nativeSessionId && session.nativeSessionPreallocated);
  if (!session.nativeSessionId && harness.session?.idKind === 'uuid' && turn.createIdPrefix) {
    session.nativeSessionId = randomUUID();
    session.nativeSessionPreallocated = true;
    createdHere = true;
  } else if (!session.nativeSessionId && harness.session?.idKind === 'history-file' && turn.createIdPrefix) {
    const nativeDirectory = join(stateDirectory(), 'native', harness.command);
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
    session.nativeSessionId = join(nativeDirectory, `${session.id}.history.md`);
    session.nativeSessionPreallocated = true;
    createdHere = true;
  } else if (!session.nativeSessionId && harness.session?.createSessionArgv) {
    session.nativeSessionId = await captureNativeHarness(harness, harness.session.createSessionArgv, environment);
    createdHere = true;
  }
  const argv = nativeHarnessTurnArgv(harness, {
    prompt: turnText, nativeSessionId: session.nativeSessionId, createdHere,
    model, workspace: session.workspace, effort,
    permissionMode: turnPermissionMode(harness, session.permissionMode), images, options: session.harnessOptions,
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
  // One stream position per attempt: a retry is a new response, and
  // a vendor's per-record session ids must not decide which records
  // belong together (see adapters.ts StreamState).
  const stream = createStreamState();
  /** Usage already reached the observer line by line, the moment each record
   * arrived. Only a harness whose output is one document at exit (or text)
   * leaves it to be read afterwards. */
  let sawLineUsage = false;
  // A Claude-shaped `result` carries its PROCESS's running cost, not the turn's
  // (running-cost.ts); a resumed Claude conversation may have restored the
  // cost it had reached. Every other reading is the turn's own and untouched.
  const processCost = harness.parser === 'claude-stream-json' ? new ProcessCost(harness.command === 'claude' && !createdHere) : undefined;
  const turnCost = (usage: TurnUsage): TurnUsage => processCost && usage.costUsd !== undefined ? { ...usage, costUsd: processCost.note(usage.costUsd) } : usage;
  // A stream-json stdin stays open while the vendor has background work
  // running, so the turn it starts when that work finishes reaches this
  // conversation instead of being killed at exit (background-wait.ts).
  // A message typed while this turn runs goes straight to the vendor.
  const streamJsonInput = turn.promptInput === 'stdin' && turn.stdinFormat === 'stream-json';
  // Pi's RPC mode takes the same: stdin stays open for the turn so a message
  // typed meanwhile is a `steer` command (pi-rpc.ts).
  const piRpc = turn.promptInput === 'stdin' && turn.stdinFormat === 'pi-rpc';
  const ampStream = turn.promptInput === 'stdin' && turn.stdinFormat === 'amp-json';
  const heldInput = streamJsonInput || piRpc || ampStream ? createTurnInput() : undefined;
  // An answer with background tasks still running ends this
  // turn at once; the process is kept, and what it says when a task
  // finishes becomes a background turn (held-vendor.ts). With nobody to
  // show that (no session worker: `clikcode send`), the turn stays open
  // until the tasks finish and their result is in it -- ClikCode does not
  // cut short work it was asked for.
  const backgroundHandler = streamJsonInput ? vendorBackgroundTurnHandlerFor(session.id) : undefined;
  const release = backgroundHandler ? createTurnRelease() : undefined;
  let held: HeldVendor | undefined;
  const heldStreams = new WeakMap<object, ReturnType<typeof createStreamState>>();
  const background = streamJsonInput && heldInput ? createBackgroundWait({
    onSettled: () => {
      run.liveInput?.setSteerHandler(undefined);
      heldInput.end();
    },
    onQuiet: () => held?.quiet(),
    // The task's own tool row already shows it; what the turn is waiting on
    // goes on the status line, the rest to the lifecycle log.
    onTaskStarted: (id, description) => {
      lifecycle('turn.background-task', { session: session.id, task: id, state: 'started' });
      if (!held) prompter?.phase(`background: ${description}`);
    },
    onTaskFinished: (id, status) => {
      lifecycle('turn.background-task', { session: session.id, task: id, state: status });
    },
  }) : undefined;
  const piTurn = piRpc && heldInput ? createPiRpcTurn({
    close: () => { run.liveInput?.setSteerHandler(undefined); heldInput.end(); },
  }) : undefined;
  const ampTurn = ampStream && heldInput ? createAmpStreamTurn({
    prompt: turnText, write: (text) => heldInput.write(text),
    close: () => { run.liveInput?.setSteerHandler(undefined); heldInput.end(); },
  }) : undefined;
  if (ampTurn) run.liveInput?.setSteerHandler(async (text, submission, hold) => {
    await ampTurn.steer(text, hold);
    if (submission.kind !== 'note') await checkpoint.steer(submission);
  });
  if (heldInput && piTurn) {
    run.liveInput?.setSteerHandler(async (steerText, submission) => {
      if (piTurn.settled) throw new Error('turn is finishing');
      const id = randomUUID();
      const taken = piTurn.await(id);
      taken.catch(quiet('turn/vendor-cli-attempt'));
      if (!heldInput.write(piRpcSteer(id, steerText))) throw new Error('turn is finishing');
      await taken;
      if (submission.kind !== 'note') await checkpoint.steer(submission);
    });
  }
  if (heldInput && background) {
    run.liveInput?.setSteerHandler(async (steerText, submission) => {
      if (background.settled || !heldInput.write(streamJsonUserMessage(steerText))) throw new Error('turn is finishing');
      background.noteInput();
      if (submission.kind !== 'note') await checkpoint.steer(submission);
    });
  }
  const stdinText = turn.promptInput !== 'stdin' ? undefined
    : piRpc ? await piRpcPrompt(turnText, images) : ampStream ? ampUserMessage(turnText) : heldInput ? streamJsonUserMessage(turnText) : turnText;
  // The global MCP servers, for a harness that takes them per run (Amp's --mcp-config).
  const mcp = await nativeMcpConfig(harness);
  argv.unshift(...mcp.argv);
  try {
    turnOutput = await captureNativeHarnessTurn(harness, argv, environment, {
    cwd: session.workspace,
    signal,
    stdinText,
    ...(heldInput ? { input: heldInput } : {}),
    ...(release ? { release } : {}),
    onStdoutLine: (lineText) => {
      // Parsed here, once: every reader below takes this record.
      const record = parseJsonRecord(lineText);
      if (piTurn && record) piTurn.note(record);
      if (ampTurn && record) ampTurn.note(record);
      if (held) {
        held.line(lineText, record);
        void recordNativeStreamUsage(session, lineText).catch(quiet('turn/vendor-cli-attempt'));
        return;
      }
      if (background && record) background.note(record);
      // The same observer every other transport is handed. What is left
      // here is the turn loop's own bookkeeping, which no line parser
      // should be doing: confirming an optimistically minted session id,
      // the quota probe, and persisting what the harness says about
      // itself.
      const outcome = reportStructuredLine(harness, lineText, {
        ...sharedObserver,
        onUsage: (usage) => sharedObserver.onUsage?.(turnCost(usage)),
        onResponseDelta: (text, mode) => {
          onOutputStart();
          sharedObserver.onResponseDelta?.(text, mode ?? 'append');
        },
        onActivity: (event) => {
          onOutputStart();
          sharedObserver.onActivity?.(event);
        },
      }, stream, record);
      if (outcome.usage) sawLineUsage = true;
      if (outcome.live) confirmNativeSession();
      if (outcome.error) onStreamError(outcome.error);
      // Answered, and only background tasks left: the turn is over.
      if (outcome.result && release && background && backgroundHandler
        && background.pending > 0 && background.quiet && !background.settled) {
        run.liveInput?.setSteerHandler(undefined);
        const owner = { harness: harness.command, accountId: session.nativeThreadAccountId ?? session.accountId ?? undefined };
        held = holdVendorProcess({
          sessionId: session.id, background, release, handler: backgroundHandler,
          owner,
          workEnded: (ended) => reportEndedWork(session.id, ended, owner),
          endInput: () => heldInput!.end(),
          // One stream position per background turn, like per attempt.
          report: (text, observer, parsed) => {
            let position = heldStreams.get(observer);
            if (!position) { heldStreams.set(observer, position = createStreamState()); position.agentRows = stream.agentRows; }
            reportStructuredLine(harness, text, observer, position, parsed);
          },
        });
      }
      // The harness reports its own quota on this stream. Reading it here
      // costs nothing and refreshes on every turn, which is what keeps the
      // shared OAuth usage endpoint -- a per-account budget several open
      // chats used to exhaust between them -- down to a cold-start probe.
      // (Self-gated on a substring, so it does not re-parse ordinary lines.)
      void recordNativeStreamUsage(session, lineText).catch(quiet('turn/vendor-cli-attempt'));
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
    // Read by the vendor at its start; the process is gone (or held, past its start).
    void mcp.dispose();
    // Whatever ended the process, input to it has nowhere to go now --
    // unless it was handed on still running.
    if (background && !held) {
      run.liveInput?.setSteerHandler(undefined);
    }
    // The process is gone: an agent it ran in the background went with it.
    if (!held) for (const event of stream.agentRows.settle('tool-error', true)) sharedObserver.onActivity?.(event);
    if (piTurn) {
      piTurn.ended();
      run.liveInput?.setSteerHandler(undefined);
    }
    if (ampTurn) { ampTurn.ended(); run.liveInput?.setSteerHandler(undefined); }
  }
  if (turnOutput.interrupted) throw turnCancelledError();
  let cliResult = nativeTurnResult(harness, turnOutput.stdout, { exitCode: turnOutput.exitCode, stderr: turnOutput.stderr });
  // Aider's stdout is its banner, the answer and a cost footer; its own
  // chat history file holds the answer alone (see events/aider.ts).
  // When that file exists it alone decides: a turn with no reply in it
  // failed, and the notice Aider quoted there says why. Stdout is only
  // read when there is no file, since there the error sits where an
  // answer would.
  if (harness.parser === 'aider') {
    const history = session.nativeSessionId ? await readFile(session.nativeSessionId, 'utf8').catch(() => '') : '';
    const reply = history ? aiderHistoryReply(history) : aiderStdoutReply(turnOutput.stdout);
    if (!reply) {
      const notice = history ? aiderHistoryNotice(history) : undefined;
      throw Object.assign(new Error(`${harness.displayName}: ${notice ?? 'returned no reply'}`), {
        stderrTail: [notice, turnOutput.stderr.trim()].filter(Boolean).join('\n').slice(-4000),
        stdoutTail: turnOutput.stdout.trim().slice(-4000),
      });
    }
    cliResult = { ...cliResult, text: reply };
  }
  if (!cliResult.isError) confirmNativeSession();
  if (!sawLineUsage && cliResult.usage) sharedObserver.onUsage?.(turnCost(cliResult.usage));
  return cliResult;
}
