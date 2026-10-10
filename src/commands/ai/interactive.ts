/**
 * The interactive session: one terminal, one conversation, until you leave.
 *
 * Everything here exists because a human is watching. It owns the prompter's
 * lifetime, the claim that stops two terminals from driving one conversation,
 * the routing of each typed line to either a turn or a slash handler, and the
 * unwinding of all of that on exit -- including exits it did not choose, like
 * a mobile SSH connection dropping mid-turn.
 */
import { lifecycle, setLifecycleRole } from '../../runtime/lifecycle-log.js';
import { STOPPED } from '../../harness/protocol/wording.js';
import { currentWorkerBuild } from '../../worker/registry.js';
import { isClikCodeAgent, isGatewayService } from '../../session/route.js';
import { gatewayCreditLabel } from '../../gateway/credit-label.js';
import { reconcileLocalModelLeases } from './local-model.js';
import { withArgValues } from '../../tui/slash/arg-values.js';
import { isUsageExhaustedMessage, resumeWaitLabel } from '../../turn/usage-exhausted.js';
import { failureLine } from '../../harness/protocol/stderr-line.js';
import { isShellCommandLine, shellMessageContent, type ShellNote } from './shell-run.js';
import type Conf from 'conf';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { runNativeHarnessCommand } from '../../harness/transport/native/command.js';
import { spawnPortable as spawn } from '../../harness/transport/spawn.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { sessionProviderLabel } from '../../harness/protocol/labels.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { consumeSessionTurn } from '../../turn/checkpoint.js';
import { nativeUsageReading, recheckRecoveredAccounts } from '../../harness/accounts/account-usage.js';
import { warmNativeModelCatalog } from '../../harness/accounts/model-catalog.js';
import { usageResetLabel } from '../../harness/accounts/usage-reading.js';
import { closePersistentTransport, nativeAvailableCommands } from '../../turn/vendor-process.js';
import { synchronizeNativeTranscript } from '../../turn/handoff.js';
import { runSessionTurn } from '../../turn/session-turn.js';
import { TERMINAL } from '../../tui/active-terminal.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { TerminalHarnessPrompter } from '../../tui/prompter.js';
import { terminalUiSupported } from '../../tui/capabilities.js';
import { SESSION_CLAIM_TTL_MS } from '../../session/claim.js';
import { activateSession, afterTurnFailure, claimConversation, leaveConversation, openConversation, prepareTurn, releaseConversationClaim, resolveSessionModel } from '../../session/attach.js';
import { slashPalette } from '../../tui/slash/registry.js';
import { runningActivityLabel, sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversation } from './conversations.js';
import { signInBeforeUse } from './harness.js';
import { signInOutcomeSaid } from '../account.js';
import { runShellLine } from '../../tui/slash/handlers.js';
import { sessionHarness, sessionOrProviderHarness, slashExtrasFor } from '../../tui/slash/context.js';
import { dispatchLine, type SlashHost } from '../../tui/slash/dispatch.js';
import { browseSearch } from '../../tui/slash/search-browse.js';
import { stopWaitingForReset, type ExhaustionRetryGuard } from '../../tui/pickers/resume-in.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';
import { autoSelectSessionHarness, interactiveEnginePicker } from '../../tui/pickers/engine.js';
import { interactiveEffortPicker } from '../../tui/pickers/effort.js';
import { interactiveModelPicker } from '../../tui/pickers/model.js';
import { interactiveSessionPicker } from '../../tui/pickers/session.js';
import type { InteractiveSlashOutcome } from '../../tui/slash/interactive-keys.js';
import { closeAllWorkerClients, followWorkerTurn, prepareSessionWorker, questionOrWorker, refreshSessionWorker, releaseSessionWorker, runTurnThroughWorker, workerQueueMark, workerTurn } from '../../worker/turn-bridge.js';
import { shownSettingsKey } from '../../worker/protocol.js';
import { retireStaleWorkers } from '../../worker/client.js';
import { replaceCliWithNewBuild } from './build-replace.js';

const DELETED_ELSEWHERE = 'That conversation was deleted · this is a new one';
/** What Left on an empty prompt returns: not a slash line, so it cannot be
 * typed, and it opens the board however the registry changes. */
const BOARD_LINE = '\u0000board';

/** Where a turn this window joins mid-way already is: when it started and
 * what it is running, from its journal -- only when that journal is the turn
 * being followed. */
function joinedTurn(session: HarnessSession, runningPrompt: string | undefined): { startedAt?: number; activity?: string } | undefined {
  const pending = session.pendingTurn;
  if (!pending || (runningPrompt !== undefined && pending.prompt.trim() !== runningPrompt.trim())) return undefined;
  const startedAt = Date.parse(pending.startedAt);
  const activity = runningActivityLabel(pending);
  return { ...(Number.isNaN(startedAt) ? {} : { startedAt }), ...(activity ? { activity } : {}) };
}

/** What a `/` offers on the conversation board: the settings a new
 * conversation starts with. */
const BOARD_COMMANDS: readonly PickerOption<string>[] = [
  { label: '/provider', detail: '· the harness the new conversation runs in', value: '/provider' },
  { label: '/model', detail: '· its model', value: '/model' },
  { label: '/effort', detail: '· its reasoning effort', value: '/effort' },
];

// An ANSI terminal runs every turn through a session worker. A terminal with
// no alternate screen (`terminal` undefined below: CI consoles, IDE output
// panes, Emacs shells, screen-reader mode -- see capabilities.ts) runs its
// turn in process: a worker has no screen to hand back to it. That path is
// why claim.ts stays, recording which process holds a conversation.
// claims.ts is unrelated -- it is the file lock on index.json.
//
// SIGINT remains ignored around client-side identity derivation and vendor
// login, which the worker design keeps in the client. SIGHUP is different:
// the terminal restore handler tears down the UI and exits the client, while
// its detached worker can finish an in-flight turn and serve a reconnect.

export async function aiSessionOpenDefault(config: Conf, options: { continue?: boolean } = {}): Promise<void> {
  await aiSessionInteractive(config, await openConversation(process.cwd(), options.continue ? 'continue' : 'new'));
}

export async function aiSessionResume(config: Conf, ref: string): Promise<void> {
  await aiSessionInteractive(config, await openConversation(process.cwd(), 'resume', ref));
}

export async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  // Fetched while the app starts, so Copilot's model list is there the first
  // time the picker opens rather than racing the picker's short wait.
  void import('../../harness/accounts/goose-discovery.js').then(({ modelsDevCache }) => modelsDevCache()).catch(() => undefined);
  // SIGINT is ignored for a related but distinct reason: run()'s own Ctrl+C
  // forwarding to a login/turn subprocess is removed the INSTANT that
  // subprocess exits -- but the terminal stays in cooked mode (raw mode
  // off, from suspend()) for everything that happens after, including this
  // codebase's own identity-derivation retry loop, which can legitimately
  // run for several seconds with nothing visibly changing on screen. A
  // Ctrl+C landing in that specific gap -- a completely natural thing to do
  // when the screen looks idle right after pasting an auth code --
  // previously had no handler registered at all, so Node's default SIGINT
  // action (immediate termination) applied, killing the process mid-save.
  // While raw mode IS active (the normal composer state), Ctrl+C is read
  // as data (byte 0x03) handled entirely inside this UI, never reaching
  // the OS as a real signal at all -- so ignoring the signal here changes
  // nothing about that existing, working "cancel the current turn"
  // behavior; it only closes the gap where raw mode is temporarily off and
  // nothing else is watching. /exit and /quit remain the ways to leave.
  const ignoreInterrupt = (): void => {};
  process.on('SIGINT', ignoreInterrupt);
  setLifecycleRole('window', id);
  lifecycle('window.open', { cols: process.stdout.columns, rows: process.stdout.rows, tty: Boolean(process.stdin.isTTY) });
  try {
    await aiSessionInteractiveInner(config, id);
    lifecycle('window.exit', { how: 'left' });
  } catch (error) {
    lifecycle('window.exit', { how: 'error', message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    throw error;
  } finally {
    process.off('SIGINT', ignoreInterrupt);
  }
}

async function aiSessionInteractiveInner(config: Conf, id: string): Promise<void> {
  // Reassigned whenever a nested flow writes its own state: `session` must stay
  // a member of whichever snapshot we later hand to writeState, or that write
  // both reverts the nested flow's work and drops our own edits.
  let state = await readState({ transcripts: [id] });
  let session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // Palette rows come from the ONE slash registry (with argHint/group).
  // slashPalette itself leaves out everything the vendor harness owns -- its
  // manager commands, whatever an ACP agent advertised, and the `/<harness>`
  // switch rows -- so what the palette shows is ClikCode's own commands plus
  // the user's custom templates, never the terminal CLI's list mixed in.
  let paletteState: Pick<HarnessState, 'accounts' | 'sessions'> = state;
  const slashCommandsFor = (target: HarnessSession): PickerOption<string>[] => {
    const harness = sessionHarness(target);
    return withArgValues(slashPalette(target, harness, slashExtrasFor(target, harness)), target, harness, paletteState);
  };
  // Created before auto-select so a first-ever install/sign-in — the most
  // common time either is actually needed — has somewhere to show its
  // "installing…" spinner and a real terminal to suspend into for a vendor
  // login prompt, instead of running headless before the UI exists.
  //
  // `terminal` is the one test for "this is the terminal UI": the plain
  // readline below (no alternate screen) has no render, panel or notice.
  const terminal = terminalUiSupported() ? new TerminalHarnessPrompter() : undefined;
  const rl: HarnessPrompter = terminal
    ?? createInterface({
      input, output, terminal: false, historySize: 1_000, removeHistoryDuplicates: true,
      completer: (value: string) => {
        const fallbackCommands = slashCommandsFor(session!).map((item) => item.value);
        const matches = fallbackCommands.filter((command) => command.startsWith(value));
        return [matches.length ? matches : fallbackCommands, value] as [string[], string];
      },
    });
  if (terminal) TERMINAL.active = terminal;
  terminal?.render(session);
  let selectionNotice: string | undefined;
  if (!session.nativeHarness && !isClikCodeAgent(session)) {
    // Nothing here ends ClikCode: Esc on the picker leaves the chat with no
    // provider (the first message or command that needs one asks again), and
    // a harness that cannot be installed from here says how, on screen.
    try {
      const auto = await autoSelectSessionHarness(id);
      if (!auto) {
        const selected = await interactiveEnginePicker(config, rl, id);
        if (selected && selected !== id) id = selected;
      }
    } catch (error) {
      selectionNotice = error instanceof Error ? error.message : String(error);
    }
    // The picker and auto-select each ran their own read/write cycle, so the
    // snapshot above is stale. Adopt the current one wholesale.
    state = await readState({ transcripts: [id] });
    const next = state.sessions.find((item) => item.id === id);
    if (!next) return;
    session = next;
  }
  // Any number of shells can have this same chat open; the shared worker
  // (worker/turn-bridge.ts) is what actually serializes turns, steering into
  // one already running rather than racing it. The claim below is informational
  // bookkeeping only -- which shell most recently opened this chat -- never a
  // lock that keeps another shell from typing.
  if (activateSession(session)) await writeState(state);
  await resolveSessionModel(id);
  await claimConversation(id);
  state = await readState({ transcripts: [id] });
  const opened = state.sessions.find((item) => item.id === id);
  if (!opened) return;
  session = opened;
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  // Warm `/model` while the composer is up, so the first open is not a wait.
  // Re-warmed when the chat's provider or account changes (see the loop).
  let warmedCatalogKey = '';
  const warmCatalogFor = (target: HarnessSession, targetState: HarnessState): void => {
    const key = `${target.nativeHarness ?? ''}\0${target.provider ?? ''}\0${target.accountId ?? ''}`;
    if (key === warmedCatalogKey) return;
    warmedCatalogKey = key;
    const harness = sessionOrProviderHarness(target);
    warmNativeModelCatalog(harness, target.accountId ? targetState.accounts.find((item) => item.id === target.accountId) : undefined);
  };
  warmCatalogFor(session, state);
  if (terminal) terminal.render(session, initialAccount, selectionNotice);
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = (target: HarnessSession, targetState: HarnessState, afterTurn = false): void => {
    if (!terminal) return;
    // A Gateway conversation's allowance is its credit.
    if (isGatewayService(target)) {
      void gatewayCreditLabel(config, { fresh: afterTurn }).then((label) => {
        if (TERMINAL.active === terminal) terminal.usage(label);
      }).catch(() => { /* Usage is optional provider metadata. */ });
      return;
    }
    void nativeUsageReading(target, targetState).then((reading) => {
      // A turn parked for the reset says so instead of when it comes back.
      if (TERMINAL.active === terminal) terminal.usage(reading?.label, target.resumeAt ? resumeWaitLabel(target.resumeAt) : usageResetLabel(reading?.windows));
    }).catch(() => { /* Usage is optional provider metadata. */ });
  };
  refreshUsage(session, state);
  // The claim's heartbeat: this terminal holds the conversation while it is
  // open; a killed one stops renewing and frees it (session/claims.ts).
  const claimInterval = setInterval(() => {
    void claimConversation(id).catch(() => undefined);
  }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
  claimInterval.unref();
  // This process's own build, fingerprinted once at startup the same way a
  // session worker's is (registry.ts). The terminal cannot hot-swap the code
  // it has loaded. When a newer build is on disk, this process re-execs onto
  // the same chat at a quiet moment: an idle composer, or the board after
  // running chats finish. Nothing is said until then: a build landing is not
  // the user's news, and the re-exec keeps the screen. Workers already step
  // down on their own (idle now, busy when the turn ends).
  const startupBuild = currentWorkerBuild();
  let updateSeen = false;
  let usageInterval: ReturnType<typeof setInterval> | undefined;
  /** Let go on both ways out: leaving, and handing over to a newer build. */
  const releaseWindow = async (): Promise<void> => {
    if (usageInterval) clearInterval(usageInterval);
    clearInterval(claimInterval);
    await closeAllWorkerClients().catch(() => undefined);
    await closePersistentTransport().catch(() => undefined);
    // Nothing it showed keeps a local model up, even if this process lives
    // on (the exit hook covers a hard exit).
    await reconcileLocalModelLeases(undefined).catch(() => undefined);
  };
  const newerBuild = (): boolean => Boolean(startupBuild && currentWorkerBuild() !== startupBuild);
  const beginBuildReplace = (): Promise<void> | undefined => {
    if (!terminal || !newerBuild()) return undefined;
    const sessionId = id;
    return replaceCliWithNewBuild({
      sessionId,
      closeUi: () => terminal.close(),
      release: async () => {
        await releaseWindow();
        // The chat stays. Discarding a blank one here would make the new
        // process's `sessions resume` miss it.
        await releaseConversationClaim(sessionId).catch(() => undefined);
      },
    });
  };
  let notice: string | undefined;
  const noteNewerBuild = (): void => {
    if (!newerBuild()) return;
    if (!updateSeen) {
      updateSeen = true;
      // Unattached workers notice the rebuild themselves. A worker a window
      // keeps attached -- one never idle enough to re-exec (a draft, a
      // picker) -- is reached only by this ask.
      void retireStaleWorkers().catch(() => undefined);
    }
    if (terminal?.idleForBuildReplace()) void beginBuildReplace();
  };
  // Without this tick, usage only ever refreshed at session-open and right after
  // each submitted message -- fine for a quick back-and-forth, but a long
  // turn or an idle stretch between messages left the number sitting there
  // stale for however long that gap was. nativeUsageReading decides whether
  // asking costs anything: it reuses a reading until a window it describes
  // resets or a turn starts on the account (in any terminal), and holds a
  // balance or a failed probe briefly. This is what asks. It also notices a
  // newer build.
  usageInterval = terminal ? setInterval(() => {
    noteNewerBuild();
    void readState({ transcripts: [] }).then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === id);
      if (latest) refreshUsage(latest, latestState);
      // The other accounts too, but only one whose quota may have come back:
      // otherwise an account that ran out showed its last "0% left" until
      // someone happened to open the picker, and read as spent for hours.
      return recheckRecoveredAccounts(latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
    // How soon the status line shows a turn another terminal ran on this
    // account, or a window that reset.
  }, 15_000) : undefined;
  /** The conversation as this window last read it: what a fresh one copies
   * its setup from when this one is deleted under it. */
  let lastSeen: HarnessSession = session;
  /** A message to send next, without asking: the one that ran out of usage,
   * after "Resume in" moved the chat to a harness that has some. */
  let resend: string | undefined;
  /** Left was pressed during a turn: the board opens next, with the turn
   * still running behind it (see startWaiting's onLeave). */
  let openBoard = false;
  /** The same-provider retry after running out, at most once per
   * interrupted turn, so a record that keeps flipping cannot loop. */
  const exhaustionGuard: ExhaustionRetryGuard = {};
  let synchronizedSessionId = '';
  let transportSessionId = id;
  /** `<session id> <route>` this terminal last prepared a worker for. */
  let preparedRoute: string | undefined;
  /** What this terminal last read of the conversation's settings: a change
   * between two reads (a /account, /model, sign-in) is sent to the worker so
   * every other window attached to it re-renders. */
  let shownSettings: string | undefined;
  /** A turn failed (see afterTurnFailure): one this window submitted, or one
   * it was only following -- most often "All accounts exhausted" from a
   * worker this window did not drive; left uncaught that crashed the loop
   * merely for reopening the chat. Running out is not shown behind an
   * "Error:". Carried on, the next pass sends `resend` (or, with none, follows
   * the turn another window carried on). */
  const handleTurnFailure = async (error: unknown, failed: { line?: string; sent?: string; queuedTurnId?: string }): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    // The whole vendor text is for `clikcode logs`; the screen gets one line.
    lifecycle('window.turn.error', { message: message.slice(0, 8000) });
    // Keep the submitted message visible when there's an error, so the user sees what failed
    // (don't clear it like we would for a turn that never started properly)
    // A sign-in that did not sign in has said so in its own line.
    if (signInOutcomeSaid(error)) return;
    const next = await afterTurnFailure(terminal, id, error, { ...failed, guard: exhaustionGuard });
    if (next.cancelled && terminal) { notice = STOPPED; return; }
    if (!terminal) { emitHarnessOutput({ panel: 'error', message: failureLine(message) }); return; }
    if ('retry' in next) { resend = next.retry; return; }
    if ('moved' in next) { id = next.moved.id; resend = next.moved.prompt; return; }
    if (next.waiting) {
      // The worker sends it at the reset; it hears of the parked turn now.
      notice = `${resumeWaitLabel(next.waiting)} · Esc or a new message cancels`;
      refreshSessionWorker(id);
      const parkedState = await readState({ transcripts: [] });
      const parked = parkedState.sessions.find((item) => item.id === id);
      if (parked) refreshUsage(parked, parkedState);
      return;
    }
    notice = isUsageExhaustedMessage(message) ? message : `Error: ${failureLine(message)}`;
    if (next.back.length) terminal?.restoreDraft(next.back.join('\n\n'));
  };
  try {
    while (true) {
      let line: string;
      let queuedTurnId: string | undefined;
      /** This line was already handed to the loop once. Anything below that
       * would hand it back must not, or a cancelled picker loops forever. */
      let fromQueuedCommand = false;
      /** What this pass's turn actually sent, when a slash command expanded
       * the line (/review): what an interrupted turn recorded is compared to. */
      let sentPrompt: string | undefined;
      // One live Codex/ACP child per OPEN conversation: leaving it (new chat,
      // fork, resume) closes the child it had.
      if (transportSessionId !== id) {
        const leaving = transportSessionId;
        nativeAvailableCommands.delete(leaving);
        transportSessionId = id;
        // The next chat paints while the vendor child it left finishes closing.
        void closePersistentTransport(leaving);
      }
      try {
        const queueMark = terminal ? await workerQueueMark(id) : undefined;
        const latestState = await readState({ transcripts: [id] });
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) {
          // Deleted while open (another window's board, `clikcode sessions`):
          // this window carries on in a fresh conversation set up the same
          // way, and says so. Leaving ClikCode is never the answer to that.
          id = await newConversation(lastSeen.id, { sameModel: true, lastSeen });
          await claimConversation(id).catch(() => undefined);
          notice = DELETED_ELSEWHERE;
          continue;
        }
        lastSeen = latest;
        warmCatalogFor(latest, latestState);
        // Whatever the last command or turn did to the conversation this
        // terminal shows, it holds a local model for that one alone.
        await reconcileLocalModelLeases(latest);
        // The same for ClikCode's own agent: a conversation that is now on the
        // Gateway (or ClikCode Local) has its MCP servers started and the
        // Gateway connection opened before the first message; one that moved
        // to a vendor harness, or that this terminal left, stops them.
        const routeKey = `${latest.id} ${latest.route}`;
        if (routeKey !== preparedRoute) {
          const leftId = preparedRoute?.split(' ')[0];
          if (leftId && leftId !== latest.id) releaseSessionWorker(leftId);
          preparedRoute = routeKey;
          void prepareSessionWorker(latest.id, { spawn: isClikCodeAgent(latest) }).catch(() => undefined);
        }
        const settingsKey = shownSettingsKey(latest);
        if (shownSettings?.startsWith(`${latest.id}|`) && shownSettings !== settingsKey) refreshSessionWorker(latest.id);
        shownSettings = settingsKey;
        const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
        paletteState = latestState;
        // A turn parked for the quota reset: Esc on an empty composer stops it.
        if (terminal) {
          const parkedId = latest.id;
          terminal.idleEscape = latest.resumeAt ? () => {
            void stopWaitingForReset(parkedId).then((stopped) => {
              if (!stopped) return;
              refreshSessionWorker(parkedId);
              delete latest.resumeAt;
              terminal.render(latest, account, 'Stopped waiting for the reset', { running: false });
              refreshUsage(latest, latestState);
            }).catch(() => undefined);
          } : undefined;
        }
        /** The turn the worker is running, followed to its end and shown as
         * this window shows its own turns: the prompt as the pending message
         * over the conversation, then the answer. `resendText` is what running
         * out of usage offers to send again. */
        const followRunning = async (terminal: TerminalHarnessPrompter, prompt: string | undefined, resendText: string | undefined): Promise<void> => {
          terminal.submitted(prompt);
          terminal.render(latest, account, undefined, { running: true, ...(prompt !== undefined ? { prompt } : {}) });
          try {
            const followed = await followWorkerTurn(latest.id, terminal, joinedTurn(latest, prompt));
            if (followed.notice) notice = followed.notice;
            if (followed.left) openBoard = true;
          } catch (error) {
            await handleTurnFailure(error, { line: resendText });
          }
        };
        // The turn the conversation's worker is running, if any -- the
        // worker's own answer. It decides whether the journal is that turn
        // (drawn by the live view once this window follows it) or an
        // interrupted one (drawn as such here); see the prompter's
        // transcriptMessages.
        const running = terminal ? await workerTurn(latest.id) : undefined;
        terminal?.render(latest, account, notice, running ? { running: true, ...running } : { running: false });
        // After a turn or a command: a Gateway balance a turn just billed.
        refreshUsage(latest, latestState, true);
        notice = undefined;
        if (synchronizedSessionId !== id) {
          const syncId = id;
          synchronizedSessionId = syncId;
          // The vendor file is reconciled after the chat is on screen. Merging
          // it first is what made Enter wait on a CLI that was not this turn.
          void synchronizeNativeTranscript(latestState, latest).then(async (changed) => {
            if (!changed || syncId !== id) return;
            await writeState(latestState);
            if (syncId === id) terminal?.render(latest, account, undefined, running ? { running: true, ...running } : { running: false });
          }).catch(() => undefined);
        }
        const queued = latest.queuedTurns?.[0];
        if (openBoard) {
          // Before anything that would follow the running turn straight back.
          openBoard = false;
          line = BOARD_LINE;
        } else {
        // A turn is running (another window's, or one the worker started):
        // the queued message waits behind it, so that turn is followed to its
        // end rather than the message sent into it only to be queued again.
        const runningTurn = queued && queued.kind !== 'command' ? running : undefined;
        if (runningTurn && terminal) {
          // Running out offers to carry on THAT turn (its prompt), and the
          // message queued behind it goes with the conversation -- offering
          // the queued text instead ran it on the branch while it also stayed
          // queued here.
          await followRunning(terminal, runningTurn.prompt, runningTurn.prompt ?? latest.pendingTurn?.prompt);
          continue;
        }
        if (resend) {
          // The turn that ran out, carried on: it came before anything
          // queued behind it, which "Resume in" moved here with it.
          line = resend;
          resend = undefined;
        } else if (queued?.kind === 'command') {
          fromQueuedCommand = true;
          // A slash command typed while the turn was running. It runs as the
          // command it is, with the screen to itself -- which is why it waited
          // rather than running mid-stream. Consumed first: a command that
          // throws must not be retried forever on every later pass.
          line = queued.text;
          if (consumeSessionTurn(latest, queued.id)) await writeState(latestState);
        } else if (queued) {
          // No notice: a queued message is echoed into the conversation as the
          // user message it is, and the waiting row underneath says a turn is
          // running. Announcing it a third time said nothing the screen did
          // not already say.
          line = queued.text;
          queuedTurnId = queued.id;
        } else if (terminal) {
          // A turn just ended, or the prompt is coming back. Do not wait out
          // the usage tick to pick up a build that landed during the turn.
          if (terminal.idleForBuildReplace()) {
            const leaving = beginBuildReplace();
            if (leaving) { await leaving; return; }
          }
          // The worker may start a turn while this sits here (another
          // window's, or a follow-up for a finished background shell), or
          // queue something: either ends the prompt, keeping the draft.
          const answer = await questionOrWorker(latest.id, (signal) => terminal.question('› ', slashCommandsFor(latest), { rightArrowPalette: true, leftArrowCommand: BOARD_LINE, ...(signal ? { signal } : {}) }), queueMark);
          if ('woke' in answer) {
            if (answer.woke === 'turn') await followRunning(terminal, answer.prompt, answer.prompt);
            continue;
          }
          line = answer.line.trim();
        } else line = (await rl.question('› ', slashCommandsFor(latest), { rightArrowPalette: true, leftArrowCommand: BOARD_LINE })).trim();
        }
      } catch (error) {
        // A non-interactive caller may close stdin after its final command.
        // Treat that exactly like leaving the foreground harness, not a crash.
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (!line) continue;
      // Left on an empty prompt: the board, through the handler /resume has.
      const viaBoard = line === BOARD_LINE;
      if (viaBoard) line = '/resume';
      /** One turn with the normal waiting / cancel / live-input UI. `echo`
       * paints the submitted text as the pending user message; synthetic
       * prompts (/review, /init, /compact) are not shown as if typed. */
      const runInteractiveTurn = async (targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> => {
        sentPrompt = promptText;
        // The submitted prompt is the prompter's for the whole turn, not a
        // message and not part of any snapshot: it is not a message yet, and
        // put in `messages` it lived somewhere the worker's next snapshot
        // overwrote -- which is what made the message the user had just sent
        // appear and then vanish. See tui/render/pending-prompt.ts. Held from
        // here, so a sign-in before the turn does not hide it either.
        terminal?.submitted(turn.echo && promptText !== INTERRUPTED_TURN_REQUEST ? promptText : undefined);
        // Using a provider no account is signed in to is when its sign-in
        // opens -- here, before the turn, so it shows on its own and its
        // outcome stays in the transcript. Nothing signed in at launch.
        // The turn's wait goes up the moment it finishes, taking whatever was
        // typed under the sign-in, so that is never drawn missing between.
        // One that does not sign in: the message was never sent, and goes
        // back to the composer (its line says how the sign-in ended).
        const signedIn = terminal ? await signInBeforeUse(targetId).catch((error: unknown) => {
          if (signInOutcomeSaid(error)) {
            terminal.submitted(undefined);
            if (turn.echo) terminal.restoreDraft(promptText);
          }
          throw error;
        }) : false;
        if (terminal && signedIn) terminal.turnStarting();
        // A draft is written now, because this message is what makes the chat
        // a conversation; the waiting line says what a local model is doing.
        const { state: activeState, active } = await prepareTurn(targetId);
        const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
        if (active && terminal) {
          const pending: HarnessSession = {
            ...active,
            messages: sessionTranscriptMessages(active),
            pendingTurn: undefined,
            ...(turn.queuedTurnId
              ? { queuedTurns: active.queuedTurns?.filter((item) => item.id !== turn.queuedTurnId) }
              : {}),
          };
          terminal.render(pending, activeAccount);
          // The worker owns cancellation, steering and the preserve-vs-discard
          // decision on a cancel (worker/session-worker.ts's runTurn), and
          // runTurnThroughWorker rethrows only a genuine failure.
          const outcome = await runTurnThroughWorker(targetId, terminal, promptText, turn);
          if (outcome.notice) notice = outcome.notice;
          if (outcome.left) openBoard = true;
          return;
        }
        output.write(`${chalk.dim(`${active ? sessionProviderLabel(active) : 'Provider'} · working…`)}\n`);
        await runSessionTurn(config, targetId, promptText, undefined, {
          persistentTransports: true,
          ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}),
        });
      };
      /** A subprocess the user has to wait for gets the same waiting indicator a turn does. */
      const withWaiting = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        if (!terminal) return work();
        terminal.startWaiting(label);
        try { return await work(); } finally { terminal.stopWaiting(); }
      };
      const showSession = async (target: string): Promise<void> => {
        const shown = await readState({ transcripts: [target] });
        const session = shown.sessions.find((item) => item.id === target);
        if (session) terminal?.render(session, session.accountId ? shown.accounts.find((item) => item.id === session.accountId)?.label : undefined);
      };
      const openConversationPicker = async (): Promise<InteractiveSlashOutcome> => {
        // The board's `/` sets up the NEXT conversation. A fresh one is
        // made the first time it is used, so choosing its provider never
        // hands off the chat that was open; if nothing is sent it stays
        // blank, and blank chats are not listed or kept.
        let fresh: string | undefined;
        for (;;) {
          const picked = await interactiveSessionPicker(rl, fresh ?? id, BOARD_COMMANDS, {
            // Running rows were on screen and have finished, and the
            // composer is empty. Leave only when a newer build is waiting.
            onSessionsSettled: () => Boolean(beginBuildReplace()),
          });
          if (picked && 'command' in picked) {
            fresh ??= await newConversation(id, { sameModel: true });
            if (picked.command === '/provider') fresh = await interactiveEnginePicker(config, rl, fresh) ?? fresh;
            else if (picked.command === '/model') await interactiveModelPicker(rl, fresh);
            else if (picked.command === '/effort') await interactiveEffortPicker(rl, fresh);
            await showSession(fresh);
            continue;
          }
          if (picked && 'compose' in picked) return { id: fresh ?? await newConversation(id, { sameModel: true }), prompt: picked.compose, echo: true };
          if (picked && 'new' in picked) return { id: fresh ?? await newConversation(id, { sameModel: true }) };
          if (picked) return { id: picked.id, ...(picked.draft ? { draft: picked.draft } : {}) };
          // Closed: back where it was, including the line that names the
          // provider, which showed the fresh chat's while it was set up.
          if (fresh) await showSession(id);
          return { id };
        }
      };
      try {
        // A queued live-composer submission is always conversation text. A
        // leading slash or path in it must not turn into a local command when
        // it is automatically dispatched after the active turn.
        if (queuedTurnId) {
          await runInteractiveTurn(id, line, { echo: true, queuedTurnId });
          continue;
        }
        // `!<command>`: a literal shell command, run here in the user's
        // terminal. Its output becomes a transcript message (so the model sees
        // it next turn) and a shell note (so even a resumed native-harness
        // thread -- which never replays ClikCode's transcript -- still sees it;
        // see shellContextBlock in turn/session-turn.ts). No approval, no model, no
        // parsing: exactly what was typed, in the workspace, with the user's
        // environment.
        if (isShellCommandLine(line)) {
          const command = line.trim().slice(1).trim();
          if (!command) {
            // A bare `!` cannot be escaped yet and is never good conversation;
            // teach instead of silently sending it to a model.
            notice = 'Type `!<command>` to run it and give the model its output, e.g. `!git status`.';
            continue;
          }
          const controller = new AbortController();
          terminal?.startWaiting(`! ${command}`, () => controller.abort());
          let result: ShellNote;
          try {
            result = await runShellLine(id, command, controller.signal);
          } finally {
            terminal?.stopWaiting();
          }
          // The run is a transcript message -- command, output, exit -- which
          // the terminal draws with the conversation; a notice repeating its
          // exit said it twice. Without a terminal nothing draws it.
          if (!terminal) emitHarnessOutput({ panel: 'shell', text: shellMessageContent(result) });
          continue;
        }
        const host: SlashHost = {
          config, prompter: rl, canPick: Boolean(terminal),
          panel: (kind, title, body, plain) => {
            if (terminal) terminal.panel(title, body);
            else emitHarnessOutput({ panel: kind, text: plain });
          },
          withBusy: withWaiting,
          ask: (label) => rl.question(`${label} › `, undefined, { cancellable: true }).catch((error: unknown) => {
            if ((error as { code?: string }).code === 'ERR_PROMPT_CANCELLED') return undefined;
            throw error;
          }),
          redraw: showSession,
          runTurn: (targetId, promptText) => runInteractiveTurn(targetId, promptText, { echo: false }),
          openConversationPicker,
          editFile: async (path, cwd) => {
            const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
            const [editorBinary = 'vi', ...editorArgs] = editor.split(/\s+/).filter(Boolean);
            await terminal?.suspend();
            try {
              await new Promise<void>((resolveEdit, rejectEdit) => {
                const child = spawn(editorBinary, [...editorArgs, path], { stdio: 'inherit', cwd });
                child.once('error', rejectEdit);
                child.once('exit', () => resolveEdit());
              });
            } finally { terminal?.resume(); }
          },
          ...(terminal ? {
            runManager: async (harness, _label, argv, environment) => {
              await terminal.suspend();
              try { await runNativeHarnessCommand(harness, argv, environment); } finally { terminal.resume(); }
            },
          } satisfies Pick<SlashHost, 'runManager'> : {
            attached: (attachments) => emitHarnessOutput({ panel: 'attachments', attachments }),
          } satisfies Pick<SlashHost, 'attached'>),
          ...(terminal ? { browseSearch: (query: string) => browseSearch(terminal, query, withWaiting) } : {}),
        };
        const outcome = await dispatchLine(host, id, line, { fromQueuedCommand });
        if (outcome.notice) notice = outcome.notice;
        if (outcome.exit) break;
        if (outcome.id && outcome.id !== id) {
          // Leaving a chat nothing happened in: it does not stay behind.
          await leaveConversation(id);
          id = outcome.id;
          await claimConversation(id).catch(() => undefined);
        }
        if (outcome.draft !== undefined) terminal?.restoreDraft(outcome.draft);
        if (outcome.prompt) await runInteractiveTurn(id, outcome.prompt, { echo: outcome.echo !== false });
      } catch (error) {
        // The conversation was deleted under this window: what was typed
        // stays in the composer, for the fresh one the next pass opens.
        if (!(await readState({ transcripts: [] })).sessions.some((item) => item.id === id)) {
          terminal?.submitted(undefined);
          if (!viaBoard) terminal?.restoreDraft(line);
          continue;
        }
        // A queued message is handed back, and one that ran out of usage is
        // offered "Resume in" as a typed one is.
        await handleTurnFailure(error, { line, sent: sentPrompt ?? line, ...(queuedTurnId ? { queuedTurnId } : {}) });
      }
    }
  } finally {
    await releaseWindow();
    // Hand the conversation back so the next terminal can resume it, and do
    // not store one closed without ever being started. Best effort: a failed
    // release only means the claim expires on its own TTL.
    await leaveConversation(id);
    if (TERMINAL.active === terminal) TERMINAL.active = undefined;
    rl.close();
  }
}
