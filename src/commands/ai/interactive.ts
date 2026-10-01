/**
 * The interactive session: one terminal, one conversation, until you leave.
 *
 * Everything here exists because a human is watching. It owns the prompter's
 * lifetime, the claim that stops two terminals from driving one conversation,
 * the routing of each typed line to either a turn or a slash handler, and the
 * unwinding of all of that on exit -- including exits it did not choose, like
 * a mobile SSH connection dropping mid-turn.
 */
import { currentWorkerBuild } from '../../worker/registry.js';
import { isClikCodeAgent } from '../../session/route.js';
import { ensureTurboFitForTurn } from './turbofit.js';
import { ensureLocalModelForTurn, reconcileLocalModelLeases } from './local-model.js';
import { backfillListFacts } from '../../session/list-backfill.js';
import { chatNamed, isBlankConversation, latestChat } from '../../session/options.js';
import { withArgValues } from '../../tui/slash/arg-values.js';
import { discardIfBlank, ensureSessionOnDisk } from '../../session/blank.js';
import { isUsageExhaustedMessage } from '../../turn/usage-exhausted.js';
import { isShellCommandLine, runShellCommand, shellMessageContent, type ShellNote } from './shell-run.js';
import type Conf from 'conf';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { runNativeHarnessCommand } from '../../harness/transport/native/command.js';
import { spawnPortable as spawn } from '../../harness/transport/spawn.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactPath, sessionProviderLabel } from '../../harness/protocol/labels.js';
import { localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { consumeSessionTurn } from '../../turn/checkpoint.js';
import { enqueueCommandLine } from '../../tui/slash/queue.js';
import { impliedHarnessCommand } from '../../tui/slash/infer-provider.js';
import { aiHarnessSelect } from './harness.js';
import { nativeUsageReading, recheckRecoveredAccounts } from '../../harness/accounts/account-usage.js';
import { harnessModelLabel, resolveNativeModel, warmNativeModelCatalog } from '../../harness/accounts/model-catalog.js';
import { settingLabel } from '../../tui/pickers/setting-scope.js';
import { usageResetLabel } from '../../harness/accounts/usage-reading.js';
import { closePersistentTransport, nativeAvailableCommands, persistentTransports } from '../../turn/vendor-process.js';
import { discardInterruptedTurn } from '../../turn/turn-journal.js';
import { synchronizeNativeTranscript } from '../../turn/handoff.js';
import { turnEnvironment } from '../../turn/turn-environment.js';
import { runSessionTurn } from '../../turn/session-turn.js';
import { TERMINAL } from '../../tui/active-terminal.js';
import { emitHarnessOutput, line } from '../../harness/output.js';
import { TerminalHarnessPrompter } from '../../tui/prompter.js';
import { terminalUiSupported } from '../../tui/capabilities.js';
import { embeddedImagePaths, expandHomePath, queueAttachment, resolveStandaloneAttachment } from '../../session/attachments.js';
import { claimSession, releaseSession, sessionClaimIsLive, SESSION_CLAIM_TTL_MS } from '../../session/claim.js';
import { existsSync } from 'node:fs';
import { routeSlashInput, slashControls, slashHelpText, slashPalette, type SlashHandlerKey } from '../../tui/slash/registry.js';
import { runningActivityLabel, sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversation, newProviderConversation, releaseQueuedTurn } from './conversations.js';
import { aiSessionLeave, launchSession } from './sessions.js';
import { aiSessionCommand, slashRouteTurn } from '../../tui/slash/handlers.js';
import { sessionHarness, slashExtrasFor, slashRouteContextFor } from '../../tui/slash/context.js';
import { capabilitiesText } from '../../tui/slash/capabilities-text.js';
import { compactConversation } from '../../tui/slash/compact.js';
import { exportTranscript } from '../../tui/slash/export-transcript.js';
import { initPrompt, readMemoryFile, reviewPrompt } from '../../tui/slash/memory.js';
import { nativeManagerListing } from '../../tui/slash/native-manager.js';
import { addAccountForHarness, interactiveAccountPicker, manageAccountAction, useAddedAccount } from '../../tui/pickers/account.js';
import { interactiveResumeInPicker, sameProviderCanTakeTurn } from '../../tui/pickers/resume-in.js';
import { chooseOption } from '../../tui/pickers/choose.js';
import { autoSelectSessionHarness, interactiveEnginePicker } from '../../tui/pickers/engine.js';
import { interactiveEffortPicker } from '../../tui/pickers/effort.js';
import { interactiveHarnessOptionPicker } from '../../tui/pickers/options.js';
import { interactiveModelPicker } from '../../tui/pickers/model.js';
import { interactivePermissionPicker } from '../../tui/pickers/permissions.js';
import { interactiveSessionPicker } from '../../tui/pickers/session.js';
import { interactiveToolsPicker } from '../../tui/pickers/tools.js';
import { interactiveSettingsPicker } from '../../tui/pickers/settings.js';
import { doctorSummary } from '../../tui/doctor-summary.js';
import type { InteractiveSlashHandlerKey, InteractiveSlashOutcome } from '../../tui/slash/interactive-keys.js';
import { closeAllWorkerClients, followWorkerTurn, prepareSessionWorker, questionOrWorker, releaseSessionWorker, runTurnThroughWorker, workerQueueMark, workerTurn } from '../../worker/turn-bridge.js';
import { retireStaleWorkers } from '../../worker/client.js';
import { replaceCliWithNewBuild } from './build-replace.js';

/** Commands the terminal replaced with the board. `/resume` is ← on an empty
 * prompt; `/new` is ← and typing. They stay in the registry for the surfaces
 * without a board (VS Code, headless `sessions send`). */
const BOARD_REPLACES: ReadonlySet<string> = new Set(['resume', 'new']);
const BOARD_REPLACES_NOTICE = 'Press ← on an empty prompt for your conversations -- pick one, or type to start a new one.';
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

// The CLIKCODE_USE_WORKER escape hatch is gone: an ANSI terminal always runs
// its turns through a session worker now. What remains below is not a
// fallback for the worker -- it is the path for a terminal that has no
// alternate screen at all, which is a different thing that was easy to
// mistake for one.
//
// Three deletions the earlier plan expected here are NOT possible, and the
// reasons are worth keeping so they are not re-attempted:
//
//   - The direct in-process turn below cannot go. The worker branch is
//     gated on `rl instanceof TerminalHarnessPrompter`, and when
//     terminalUiSupported() is false `rl` is a plain readline instead. So
//     this path serves the cases capabilities.ts exists for -- CI consoles,
//     IDE output panes, Emacs shells, screen-reader mode -- and a worker
//     cannot serve them, having no screen to hand back.
//
//   - claim.ts therefore stays too, because that path still needs to record
//     which process holds a conversation.
//
//   - claims.ts was never the worker's business at all: state/write.ts,
//     state/read.ts and state/migrate.ts use it as the file lock that stops
//     two processes corrupting index.json.
//
// SIGINT remains ignored around client-side identity derivation and vendor
// login, which the worker design keeps in the client. SIGHUP is different:
// the terminal restore handler tears down the UI and exits the client, while
// its detached worker can finish an in-flight turn and serve a reconnect.

/** The index for launch / resume. Chats that predate the row summary are
 * summarized in the background; the board already does the same. Waiting here
 * made the first open after an upgrade pay for every transcript before the
 * composer appeared. */
async function stateForNavigation(): Promise<HarnessState> {
  const state = await readState({ transcripts: [] });
  if (state.sessions.some((session) => !session.listChecked && !isBlankConversation(session))) {
    void backfillListFacts().catch(() => undefined);
  }
  return state;
}

export async function aiSessionOpenDefault(config: Conf, options: { continue?: boolean } = {}): Promise<void> {
  const state = await stateForNavigation();
  if (options.continue) {
    const latest = latestChat(state.sessions, process.cwd());
    if (latest) return aiSessionResume(config, latest.id);
  }
  // Empty chats are not conversations. Do not store the one this launch
  // opens until something happens in it.
  state.sessions = state.sessions.filter((session) => !isBlankConversation(session));
  const session = launchSession(state, process.cwd());
  state.sessions.push(session);
  await writeState(state);
  await aiSessionInteractive(config, session.id);
}

export async function aiSessionResume(config: Conf, ref: string): Promise<void> {
  const state = await stateForNavigation();
  // An id, the start of one, a chat's name, or `last`.
  const id = state.sessions.some((item) => item.id === ref) ? ref : chatNamed(state.sessions, ref, '');
  const session = id ? state.sessions.find((item) => item.id === id) : undefined;
  if (!session) throw new Error(`no chat matches "${ref}" -- use its name, the start of its id, or last`);
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
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
  try {
    await aiSessionInteractiveInner(config, id);
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
    return withArgValues(slashPalette(target, harness, { ...slashExtrasFor(target, harness), omit: BOARD_REPLACES }), target, harness, paletteState);
  };
  // Created before auto-select so a first-ever install/sign-in — the most
  // common time either is actually needed — has somewhere to show its
  // "installing…" spinner and a real terminal to suspend into for a vendor
  // login prompt, instead of running headless before the UI exists.
  const rl: HarnessPrompter = terminalUiSupported()
    ? new TerminalHarnessPrompter()
    : createInterface({
      input, output, terminal: false, historySize: 1_000, removeHistoryDuplicates: true,
      completer: (value: string) => {
        const fallbackCommands = slashCommandsFor(session!).map((item) => item.value);
        const matches = fallbackCommands.filter((command) => command.startsWith(value));
        return [matches.length ? matches : fallbackCommands, value] as [string[], string];
      },
    });
  if (rl instanceof TerminalHarnessPrompter) TERMINAL.active = rl;
  rl.render?.(session);
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
  let stateChanged = false;
  // Any number of shells can have this same chat open; the shared worker
  // (worker/turn-bridge.ts) is what actually serializes turns, steering into
  // one already running rather than racing it. The claim below is informational
  // bookkeeping only -- which shell most recently opened this chat -- never a
  // lock that keeps another shell from typing.
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    stateChanged = true;
  }
  if (!session.model) {
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (harness) {
      const resolved = await resolveNativeModel(harness, account);
      if (resolved) {
        session.model = resolved;
        session.updatedAt = new Date().toISOString();
        stateChanged = true;
      }
    }
  }
  claimSession(session);
  stateChanged = true;
  if (stateChanged) await writeState(state);
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  // Warm `/model` while the composer is up, so the first open is not a wait.
  // Re-warmed when the chat's provider or account changes (see the loop).
  let warmedCatalogKey = '';
  const warmCatalogFor = (target: HarnessSession, targetState: HarnessState): void => {
    const key = `${target.nativeHarness ?? ''}\0${target.provider ?? ''}\0${target.accountId ?? ''}`;
    if (key === warmedCatalogKey) return;
    warmedCatalogKey = key;
    const harness = target.nativeHarness ? localHarnessForCommand(target.nativeHarness)
      : target.provider ? localHarnessForProvider(target.provider) : undefined;
    warmNativeModelCatalog(harness, target.accountId ? targetState.accounts.find((item) => item.id === target.accountId) : undefined);
  };
  warmCatalogFor(session, state);
  if (rl.render) rl.render(session, initialAccount, selectionNotice);
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = (target: HarnessSession, targetState: HarnessState): void => {
    if (!(rl instanceof TerminalHarnessPrompter)) return;
    void nativeUsageReading(target, targetState).then((reading) => {
      if (TERMINAL.active === rl) rl.usage(reading?.label, usageResetLabel(reading?.windows));
    }).catch(() => { /* Usage is optional provider metadata. */ });
  };
  refreshUsage(session, state);
  // Without this, usage only ever refreshed at session-open and right after
  // each submitted message -- fine for a quick back-and-forth, but a long
  // turn or an idle stretch between messages left the number sitting there
  // stale for however long that gap was, well past nativeUsageReading's own
  // 30s cache window (which bounds *how often this can update*, not
  // *whether anything ever asks it to*). This is what actually asks.
  const claimInterval = setInterval(() => {
    void refreshSessionClaim(id).catch(() => undefined);
  }, Math.floor(SESSION_CLAIM_TTL_MS / 3));
  claimInterval.unref();
  // This process's own build, fingerprinted once at startup the same way a
  // session worker's is (registry.ts). The terminal cannot hot-swap the code
  // it has loaded. When a newer build is on disk, this process re-execs onto
  // the same chat at a quiet moment: an idle composer, or the board after
  // running chats finish. Until then, one notice. Workers already step down
  // on their own (idle now, busy when the turn ends).
  const startupBuild = currentWorkerBuild();
  let updateSeen = false;
  let updateAnnounced = false;
  let usageInterval: ReturnType<typeof setInterval> | undefined;
  const newerBuild = (): boolean => Boolean(startupBuild && currentWorkerBuild() !== startupBuild);
  const beginBuildReplace = (): Promise<void> | undefined => {
    if (!(rl instanceof TerminalHarnessPrompter) || !newerBuild()) return undefined;
    const sessionId = id;
    return replaceCliWithNewBuild({
      sessionId,
      closeUi: () => rl.close(),
      release: async () => {
        if (usageInterval) clearInterval(usageInterval);
        clearInterval(claimInterval);
        await closeAllWorkerClients().catch(() => undefined);
        await closePersistentTransport().catch(() => undefined);
        await reconcileLocalModelLeases(undefined).catch(() => undefined);
        // The chat stays. Discarding a blank one here would make the new
        // process's `sessions resume` miss it.
        await releaseSessionClaim(sessionId).catch(() => undefined);
      },
    });
  };
  let notice: string | undefined;
  const noteNewerBuild = (): void => {
    if (!newerBuild()) return;
    if (!updateSeen) {
      updateSeen = true;
      void retireStaleWorkers().catch(() => undefined);
    }
    if (rl instanceof TerminalHarnessPrompter && rl.idleForBuildReplace()) {
      void beginBuildReplace();
      return;
    }
    if (!updateAnnounced) {
      updateAnnounced = true;
      if (!notice) notice = 'A newer ClikCode build will load when nothing is running.';
    }
  };
  usageInterval = rl instanceof TerminalHarnessPrompter ? setInterval(() => {
    noteNewerBuild();
    void readState({ transcripts: [] }).then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === id);
      if (latest) refreshUsage(latest, latestState);
      // The other accounts too, but only one whose quota may have come back:
      // otherwise an account that ran out showed its last "0% left" until
      // someone happened to open the picker, and read as spent for hours.
      return recheckRecoveredAccounts(latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
    // Half the usage window, so every other tick finds the reading expired and
    // refreshes it. A tick longer than the window would land inside it and
    // silently halve the real refresh rate.
  }, 15_000) : undefined;
  /** A message to send next, without asking: the one that ran out of usage,
   * after "Resume in" moved the chat to a harness that has some. */
  let resend: string | undefined;
  /** Left was pressed during a turn: the board opens next, with the turn
   * still running behind it (see startWaiting's onLeave). */
  let openBoard = false;
  /** The message last re-sent because its own provider had an account back;
   * never twice, so a record that keeps flipping cannot loop. */
  let autoResent: string | undefined;
  let synchronizedSessionId = '';
  let transportSessionId = id;
  /** `<session id> <route>` this terminal last prepared a worker for. */
  let preparedRoute: string | undefined;
  /** A turn failed: one this window submitted, or one it was only following
   * (started earlier, by another window, or by the queue -- most often "All
   * accounts exhausted" from a worker this window did not drive; left
   * uncaught that crashed the loop merely for reopening the chat). Running
   * out of quota is an outcome, not a fault, so it is not shown behind an
   * "Error:". With prompt text worth resending, out of usage offers the
   * harnesses that still have some and carries on there with the same
   * message. */
  const handleTurnFailure = async (error: unknown, promptText: string | undefined): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    if (!rl.render) { emitHarnessOutput({ panel: 'error', message }); return; }
    notice = isUsageExhaustedMessage(message) ? message : `Error: ${message}`;
    if (!promptText || !isUsageExhaustedMessage(message) || !(rl instanceof TerminalHarnessPrompter)) return;
    // An account of this provider got its quota back after failover looked
    // (a re-read landed meanwhile): send it again here, once, rather than
    // offering to leave the provider.
    const again = promptText !== autoResent && await sameProviderCanTakeTurn(id).catch(() => false);
    if (again) {
      // As Resume in does: the message is sent again, so it must not also
      // stay behind as the interrupted turn.
      await discardInterruptedTurn(id, promptText).catch(() => undefined);
      autoResent = promptText;
      resend = promptText;
      notice = undefined;
    } else {
      const moved = await interactiveResumeInPicker(rl, id, promptText).catch(() => undefined);
      if (moved) {
        id = moved;
        resend = promptText;
        notice = undefined;
      }
    }
  };
  try {
    while (true) {
      let line: string;
      let queuedTurnId: string | undefined;
      /** This line was already handed to the loop once. Anything below that
       * would hand it back must not, or a cancelled picker loops forever. */
      let fromQueuedCommand = false;
      let activeWorkspace = process.cwd();
      // One live Codex/ACP child per OPEN conversation: leaving it (new chat,
      // handoff, resume) closes the child it had.
      if (transportSessionId !== id) {
        const leaving = transportSessionId;
        nativeAvailableCommands.delete(leaving);
        transportSessionId = id;
        // The next chat paints while the vendor child it left finishes closing.
        void closePersistentTransport(leaving);
      }
      try {
        const queueMark = workerQueueMark(id);
        const latestState = await readState({ transcripts: [id] });
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) break;
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
        activeWorkspace = latest.workspace ?? process.cwd();
        const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
        paletteState = latestState;
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
            await handleTurnFailure(error, resendText);
          }
        };
        // The turn the conversation's worker is running, if any -- the
        // worker's own answer. It decides whether the journal is that turn
        // (drawn by the live view once this window follows it) or an
        // interrupted one (drawn as such here); see the prompter's
        // transcriptMessages.
        const running = rl instanceof TerminalHarnessPrompter ? await workerTurn(latest.id) : undefined;
        rl.render?.(latest, account, notice, running ? { running: true, ...running } : { running: false });
        refreshUsage(latest, latestState);
        notice = undefined;
        if (synchronizedSessionId !== id) {
          const syncId = id;
          synchronizedSessionId = syncId;
          // The vendor file is reconciled after the chat is on screen. Merging
          // it first is what made Enter wait on a CLI that was not this turn.
          void synchronizeNativeTranscript(latestState, latest).then(async (changed) => {
            if (!changed || syncId !== id) return;
            await writeState(latestState);
            if (syncId === id) rl.render?.(latest, account, undefined, running ? { running: true, ...running } : { running: false });
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
        if (runningTurn && rl instanceof TerminalHarnessPrompter) {
          await followRunning(rl, runningTurn.prompt, queued?.text);
          continue;
        }
        if (queued?.kind === 'command') {
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
        } else if (resend) {
          line = resend;
          resend = undefined;
        } else if (rl instanceof TerminalHarnessPrompter) {
          // A turn just ended, or the prompt is coming back. Do not wait out
          // the usage tick to pick up a build that landed during the turn.
          if (rl.idleForBuildReplace()) {
            const leaving = beginBuildReplace();
            if (leaving) { await leaving; return; }
          }
          // The worker may start a turn while this sits here (another
          // window's, or a follow-up for a finished background shell), or
          // queue something: either ends the prompt, keeping the draft.
          const answer = await questionOrWorker(latest.id, (signal) => rl.question('› ', slashCommandsFor(latest), { rightArrowPalette: true, leftArrowCommand: BOARD_LINE, ...(signal ? { signal } : {}) }), queueMark);
          if ('woke' in answer) {
            if (answer.woke === 'turn') await followRunning(rl, answer.prompt, answer.prompt);
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
      if (viaBoard) {
        line = '/resume';
        // Chats left behind on an older build would otherwise keep that code
        // until reopened or the idle timeout. Sweep now, while the board is
        // opening, so picking any row starts a worker on this build.
        void retireStaleWorkers().catch(() => undefined);
      }
      /** One turn with the normal waiting / cancel / live-input UI. `echo`
       * paints the submitted text as the pending user message; synthetic
       * prompts (/review, /init, /compact) are not shown as if typed. */
      const runInteractiveTurn = async (targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> => {
        // The worker is another process. A draft is written now, because this
        // message is what makes the chat a conversation.
        if (rl instanceof TerminalHarnessPrompter) await ensureSessionOnDisk(targetId);
        const activeState = await readState({ transcripts: [targetId] });
        const active = activeState.sessions.find((item) => item.id === targetId);
        const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
        // Held from this process, not the turn's worker: the worker outlives
        // the terminal, and a TurboFit model stops when the terminal closes.
        const activeHarness = active?.nativeHarness ? localHarnessForCommand(active.nativeHarness) : undefined;
        if (active && activeHarness) {
          await ensureTurboFitForTurn(activeHarness, activeState.accounts.find((item) => item.id === active.accountId), targetId, active.model);
        }
        // Likewise a ClikCode Local model: loaded here, with its progress on
        // the waiting line, and held by this terminal rather than the worker.
        await ensureLocalModelForTurn(active);
        if (active && rl instanceof TerminalHarnessPrompter) {
          // The submitted prompt is the prompter's for the whole turn, not a
          // message and not part of this snapshot: it is not a message yet, and
          // put in `messages` it lived somewhere the worker's next snapshot
          // overwrote -- which is what made the message the user had just sent
          // appear and then vanish. See tui/render/pending-prompt.ts.
          rl.submitted(turn.echo ? promptText : undefined);
          const pending: HarnessSession = {
            ...active,
            messages: sessionTranscriptMessages(active),
            pendingTurn: undefined,
            ...(turn.queuedTurnId
              ? { queuedTurns: active.queuedTurns?.filter((item) => item.id !== turn.queuedTurnId) }
              : {}),
          };
          rl.render(pending, activeAccount);
          // The worker owns cancellation, steering and the preserve-vs-discard
          // decision on a cancel (worker/session-worker.ts's runTurn), and
          // runTurnThroughWorker rethrows only a genuine failure.
          const outcome = await runTurnThroughWorker(targetId, rl, promptText, turn);
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
        if (!(rl instanceof TerminalHarnessPrompter)) return work();
        rl.startWaiting(label);
        try { return await work(); } finally { rl.stopWaiting(); }
      };
      /** The headless handler, with its output in a panel.
       *
       * No "Press Enter to return" any more. A panel is part of the frame the
       * composer is drawn in (see paint()'s panel rows) and survives every
       * repaint until the next message is sent, so the keypress bought
       * nothing: the panel was already staying, and the prompt was one more
       * thing to dismiss before the user could type. */
      const viaHeadless = async (text: string): Promise<InteractiveSlashOutcome> => {
        const resulting = await aiSessionCommand(id, text);
        return resulting !== id ? { id: resulting } : {};
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
          const waiting = rl instanceof TerminalHarnessPrompter ? rl : undefined;
          if (waiting) waiting.startWaiting(`! ${command}`, () => controller.abort());
          let result: Awaited<ReturnType<typeof runShellCommand>>;
          try {
            result = await runShellCommand(command, activeWorkspace, controller.signal);
          } finally {
            waiting?.stopWaiting();
          }
          const note: ShellNote = { command, output: result.output, exitCode: result.exitCode, at: new Date().toISOString() };
          const shellState = await readState();
          const shellSession = shellState.sessions.find((item) => item.id === id);
          if (shellSession) {
            shellSession.messages = [...(shellSession.messages ?? []), { role: 'user' as const, content: shellMessageContent(note) }];
            shellSession.shellNotes = [...(shellSession.shellNotes ?? []), note];
            shellSession.updatedAt = new Date().toISOString();
            await writeState(shellState);
          }
          notice = result.exitCode === 0
            ? `Ran \`!${command}\` (exit 0) — its output rides into the next request`
            : `\`!${command}\` ended with ${result.exitCode === null ? 'no exit code (killed or cancelled)' : `exit ${result.exitCode}`}`;
          continue;
        }
        const standaloneAttachment = await resolveStandaloneAttachment(line, activeWorkspace);
        if (standaloneAttachment) {
          const attachmentState = await readState();
          const attachmentSession = attachmentState.sessions.find((item) => item.id === id);
          if (!attachmentSession) throw new Error(`AI session "${id}" was not found`);
          await queueAttachment(attachmentSession, standaloneAttachment);
          attachmentSession.updatedAt = new Date().toISOString();
          await writeState(attachmentState);
          notice = `Attached ${compactPath(standaloneAttachment)} for the next request`;
          if (!rl.render) emitHarnessOutput({ panel: 'attachments', attachments: attachmentSession.attachments ?? [] });
          continue;
        }
        const commandState = await readState();
        const commandSession = commandState.sessions.find((item) => item.id === id);
        if (!commandSession) break;
        const commandHarness = sessionHarness(commandSession);
        // `/etc/hosts explain this` is a request about a file, not a command.
        const route = routeSlashInput(line, slashRouteContextFor(commandSession, commandHarness, (path) => existsSync(expandHomePath(path))));
        let outcome: InteractiveSlashOutcome = {};
        if (route.kind === 'prompt') {
          // An image named in the message goes with the message.
          const images = await embeddedImagePaths(route.prompt, activeWorkspace);
          if (images.length) {
            for (const image of images) await queueAttachment(commandSession, image).catch(() => undefined);
            await writeState(commandState);
          }
          outcome = { prompt: route.prompt, echo: true };
        }
        else if (route.kind === 'native' || route.kind === 'custom' || route.kind === 'unknown') {
          outcome = slashRouteTurn(route, commandSession, commandHarness) ?? {};
        }
        else if (route.kind === 'harness') {
          // `/<harness> [request]`: hand off, ADOPT the resulting session, and
          // run the request here with the normal waiting UI -- it used to run
          // headless on a branch this loop never switched to.
          const selected = await newProviderConversation(id, route.command);
          outcome = { id: selected, ...(route.args ? { prompt: route.args, echo: true } : {}) };
        }
        else if (route.kind === 'manager') {
          const manager = commandHarness ? (localHarnessCapabilityManifest(commandHarness).managers as Record<string, { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] } | undefined> | undefined)?.[route.name] : undefined;
          if (!commandHarness || !manager) throw new Error('Choose a provider first.');
          if (manager.listArgv) {
            const listing = await withWaiting(`loading ${manager.label}…`, () => nativeManagerListing(commandState, commandSession, route.name));
            rl.panel?.(listing.label, listing.text);
            if (!rl.panel) emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
          } else if (manager.manageArgv && rl instanceof TerminalHarnessPrompter) {
            const selectedAccount = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
            await rl.suspend();
            try { await runNativeHarnessCommand(commandHarness, manager.manageArgv, turnEnvironment(commandHarness, selectedAccount)); }
            finally { rl.resume(); }
          } else throw new Error(`${commandHarness.displayName} requires an interactive terminal for ${manager.label}.`);
        }
        else if (BOARD_REPLACES.has(route.entry.name) && !viaBoard) {
          notice = BOARD_REPLACES_NOTICE;
        }
        else if (route.entry.name === 'help') {
          // The terminal's own list: without the commands the board replaced.
          const extras = { ...slashExtrasFor(commandSession, commandHarness), omit: BOARD_REPLACES };
          emitHarnessOutput({ panel: 'help', helpText: slashHelpText(commandSession, commandHarness, extras), controls: slashControls().filter((item) => !BOARD_REPLACES.has(item.command.slice(1))) });
        }
        else {
          // Availability is decided BEFORE any picker opens, so `/model` on a
          // harness without a model selector says so instead of offering a list.
          const availability = route.entry.availability(commandSession, commandHarness);
          // The one refusal worth turning into a question: the command needs a
          // provider and none is chosen. The user typed `/model`, so wanting
          // to choose a model is not in doubt -- offering the provider picker
          // and then carrying on with what they typed is a better answer than
          // "Choose a provider before choosing a model." Handed back to the
          // loop rather than run here, so it runs against the session the
          // picker actually produced (choosing a provider can branch the
          // conversation) instead of the stale copy read above.
          if (!availability.available && availability.needs === 'provider' && !fromQueuedCommand) {
            const commandLine = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
            // Derived before asked: `/model claude-opus-5` has already named
            // its provider if exactly one configured account publishes that
            // model, and `/account work` always has. A picker there would ask
            // a question whose answer was in the question.
            const impliedHarness = impliedHarnessCommand(route, commandState.accounts, localHarnessForProvider);
            if (impliedHarness) {
              await aiHarnessSelect(impliedHarness, id);
              await enqueueCommandLine(id, commandLine);
              continue;
            }
            if (!rl.select) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
            const chosen = await interactiveEnginePicker(config, rl, id) ?? id;
            const chosenState = await readState({ transcripts: [chosen] });
            if (sessionHarness(chosenState.sessions.find((item) => item.id === chosen))) {
              await enqueueCommandLine(chosen, commandLine);
            }
            if (chosen !== id) id = chosen;
            continue;
          }
          if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
          const text = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
          const { args } = route;
          const showSession = async (target: string): Promise<void> => {
            const shown = await readState({ transcripts: [target] });
            const session = shown.sessions.find((item) => item.id === target);
            if (session) rl.render?.(session, session.accountId ? shown.accounts.find((item) => item.id === session.accountId)?.label : undefined);
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
              if (picked) return { id: picked.id };
              // Closed: back where it was, including the line that names the
              // provider, which showed the fresh chat's while it was set up.
              if (fresh) await showSession(id);
              return { id };
            }
          };
          const interactive: Record<InteractiveSlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>> = {
            exit: async () => { await aiSessionLeave(id); return { exit: true }; },
            new: async () => ({ id: await newConversation(id), ...(args ? { prompt: args, echo: true } : {}) }),
            redraw: async () => { rl.render?.(commandSession, commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId)?.label : undefined); },
            provider: async () => ({ id: await interactiveEnginePicker(config, rl, id) ?? id }),
            accounts: async () => {
              // `/accounts login <harness>` and `/accounts add <harness>` sign in
              // here, with the terminal handed over, the same as + Add
              // account -- run headless, the vendor's login fought ClikCode's
              // own screen for the terminal.
              const [action, name] = args.split(/\s+/);
              const target = (action === 'login' || action === 'add') && name ? localHarnessForCommand(name.toLowerCase()) : undefined;
              if (target?.surface === 'terminal') {
                const added = await addAccountForHarness(rl, target);
                if (added && target.provider === commandSession.provider) await useAddedAccount(id, target, added);
                return {};
              }
              return args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id };
            },
            // A value typed or chosen from the palette says what it set, the
            // way the pickers do.
            model: async () => {
              if (!args) return interactiveModelPicker(rl, id);
              const outcome = await viaHeadless(text);
              const model = (await readState({ transcripts: [outcome.id ?? id] })).sessions.find((item) => item.id === (outcome.id ?? id))?.model;
              if (model) rl.notice?.(`Model set to ${commandHarness ? harnessModelLabel(commandHarness, model) : model}`);
              return outcome;
            },
            effort: async () => {
              if (!args) return interactiveEffortPicker(rl, id);
              const outcome = await viaHeadless(text);
              rl.notice?.(`Effort set to ${settingLabel(args.trim().toLowerCase() === 'default' ? '' : args.trim().toLowerCase())}`);
              return outcome;
            },
            permissions: async () => {
              if (!args) return interactivePermissionPicker(rl, id);
              const outcome = await viaHeadless(text);
              rl.notice?.(`Permissions set to ${settingLabel(args.trim().toLowerCase())}`);
              return outcome;
            },
            options: async () => interactiveHarnessOptionPicker(rl, id),
            capabilities: async () => {
              const [title = 'Capabilities', ...rest] = capabilitiesText(commandSession).split('\n');
              rl.panel?.(title, rest.join('\n'));
              if (!rl.panel) emitHarnessOutput({ panel: 'capabilities', text: [title, ...rest].join('\n') });
            },
            settings: async () => {
              // `/settings tools`: straight to Tools & integrations (MCP servers, skills, agents).
              if (args.trim().toLowerCase() === 'tools') {
                if (!commandHarness) throw new Error('Choose a provider first: tools and MCP servers belong to a harness.');
                await interactiveToolsPicker(rl, id, commandHarness);
                return {};
              }
              return args ? viaHeadless(text) : { id: await interactiveSettingsPicker(config, rl, id) ?? id };
            },
            sessions: async () => {
              if (args) return viaHeadless(text);
              return openConversationPicker();
            },
            // Resume means reopening the selected conversation at its source:
            // retain its account, harness, and exact native session identity.
            // Moving a transcript to another provider remains an explicit
            // /provider action, never a side effect of choosing history.
            // `/resume <name>` goes straight there when the name picks out one
            // conversation -- the palette offers the names -- and opens the
            // list only when it does not.
            resume: async () => {
              const named = args ? chatNamed(commandState.sessions, args, id) : undefined;
              if (named) return { id: named };
              return openConversationPicker();
            },
            rename: async () => {
              const name = args || (await rl.question('Conversation name › ')).trim();
              if (name) await aiSessionCommand(id, `/rename ${name}`);
            },
            // No "[y/N]": archiving is undone by resuming it, which is where
            // an archived chat still is. A confirmation earns its keypress
            // only for what cannot be taken back -- /delete keeps its own.
            archive: async () => {
              await aiSessionCommand(id, '/archive');
              return { exit: true };
            },
            delete: async () => {
              // The same confirmation every delete uses: Cancel first.
              const confirmed = await chooseOption(rl, 'Delete this conversation?', [
                { label: 'Cancel', value: false }, { label: 'Delete this conversation', value: true },
              ]);
              if (!confirmed) return {};
              await aiSessionCommand(id, '/delete confirm');
              return { exit: true };
            },
            mention: async () => {
              const path = args || (await rl.question('File to attach › ')).trim();
              return path ? viaHeadless(`/mention ${path}`) : {};
            },
            review: async () => ({ prompt: reviewPrompt(args), echo: false }),
            init: async () => ({ prompt: initPrompt(commandSession), echo: false }),
            native: async () => {
              if (!args) throw new Error('usage: /native <text>  (or //text)');
              return { prompt: args, echo: true };
            },
            compact: async () => {
              const compacted = await compactConversation(id, commandSession, args, (targetId, promptText) => runInteractiveTurn(targetId, promptText, { echo: false }));
              // No confirmation line: the compacted conversation is what is on
              // screen now, and that is the confirmation.
              return typeof compacted === 'string' ? { id: compacted } : {};
            },
            export: async () => {
              const path = await exportTranscript(commandSession, args, async (existing) =>
                ['y', 'yes'].includes((await rl.question(`${compactPath(existing)} exists. Overwrite? [y/N] › `)).trim().toLowerCase()));
              return { notice: `Transcript written to ${compactPath(path)}` };
            },
            memory: async () => {
              if (route.words[0]?.toLowerCase() !== 'edit') return viaHeadless(text);
              const memory = await readMemoryFile(commandSession);
              const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
              const [editorBinary = 'vi', ...editorArgs] = editor.split(/\s+/).filter(Boolean);
              if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
              try {
                await new Promise<void>((resolveEdit, rejectEdit) => {
                  const child = spawn(editorBinary, [...editorArgs, memory.path], { stdio: 'inherit', cwd: commandSession.workspace ?? process.cwd() });
                  child.once('error', rejectEdit);
                  child.once('exit', () => resolveEdit());
                });
              } finally { if (rl instanceof TerminalHarnessPrompter) rl.resume(); }
              return {};
            },
            doctor: async () => {
              const report = await withWaiting('checking harnesses…', () => doctorSummary(commandState));
              rl.panel?.('ClikCode doctor', report);
              if (!rl.panel) emitHarnessOutput({ panel: 'doctor', text: report });
            },
            login: async () => {
              if (!commandHarness) throw new Error('Choose a provider before signing in.');
              // Sign the current account in again only when it needs it;
              // otherwise /login means another account, which becomes this
              // chat's. Re-running the sign-in of a working account did
              // nothing useful, and an API-key account did nothing at all.
              const current = commandSession.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
              if (current?.authKind === 'vendor-cli' && (current.status !== 'ready' || current.verification)) {
                await manageAccountAction(rl, current.id, 'reauthenticate');
                return {};
              }
              const added = await addAccountForHarness(rl, commandHarness);
              if (added) await useAddedAccount(id, commandHarness, added);
              return {};
            },
            logout: async () => {
              if (!commandSession.accountId) throw new Error('This conversation has no account to sign out.');
              await withWaiting('signing out…', () => manageAccountAction(rl, commandSession.accountId!, 'disconnect'));
              return {};
            },
          };
          const handler = (interactive as Partial<Record<SlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>>>)[route.entry.handlerKey];
          outcome = (handler ? await handler() : await viaHeadless(text)) ?? {};
        }
        if (outcome.notice) notice = outcome.notice;
        if (outcome.exit) break;
        if (outcome.id && outcome.id !== id) {
          // Leaving a chat nothing happened in: it does not stay behind.
          await discardIfBlank(id).catch(() => undefined);
          id = outcome.id;
        }
        if (outcome.prompt) await runInteractiveTurn(id, outcome.prompt, { echo: outcome.echo !== false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
        // A queued turn is only consumed once its checkpoint starts. Anything
        // that throws before that -- a removed account, an unavailable model, an
        // attachment deleted since it was queued -- leaves the same message at
        // the head of the queue, so the next iteration picks it up and fails
        // identically: a hot loop that never returns a prompt and can only be
        // cleared by hand-editing harness-state.json. Release it and hand the
        // text back so the failure is visible and recoverable.
        if (queuedTurnId && !cancelled) {
          await releaseQueuedTurn(id, queuedTurnId).catch(() => undefined);
          TERMINAL.active?.restoreDraft(line);
        }
        if (cancelled && rl.render) notice = 'Stopped';
        else await handleTurnFailure(error, queuedTurnId ? undefined : line);
      }
    }
  } finally {
    if (usageInterval) clearInterval(usageInterval);
    if (claimInterval) clearInterval(claimInterval);
    await closeAllWorkerClients().catch(() => undefined);
    await closePersistentTransport().catch(() => undefined);
    // The terminal is leaving: nothing it showed keeps a local model up,
    // even if this process lives on (the exit hook covers a hard exit).
    await reconcileLocalModelLeases(undefined).catch(() => undefined);
    // Hand the conversation back so the next terminal can resume it. Best
    // effort: a failure here only means the claim expires on its own TTL.
    await releaseSessionClaim(id).catch(() => undefined);
    // Closed without ever being started: not stored. After the claim release,
    // which reads the record it is releasing.
    await discardIfBlank(id).catch(() => undefined);
    if (TERMINAL.active === rl) TERMINAL.active = undefined;
    rl.close();
  }
}

/** Refreshes this terminal's claim on its conversation. Runs on a timer rather
 * than per turn so a long turn, or a long idle stretch, both keep the claim
 * alive without any traffic of their own. */
async function refreshSessionClaim(id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session || sessionClaimIsLive(session)) return;
  claimSession(session);
  await writeState(state);
}

async function releaseSessionClaim(id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session?.claim) return;
  releaseSession(session);
  await writeState(state);
}
