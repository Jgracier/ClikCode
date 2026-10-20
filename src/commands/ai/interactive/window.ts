/** Opening a window: the terminal, the attached and claimed conversation, its first frame, the usage tick and the newer-build watch. */
import { currentWorkerBuild } from '../../../worker/registry.js';
import { isClikCodeAgent, isGatewayService } from '../../../session/route.js';
import { gatewayCreditLabel } from '../../../gateway/credit-label.js';
import { reconcileLocalModelLeases } from '../local-model.js';
import { withArgValues } from '../../../tui/slash/arg-values.js';
import { resumeWaitLabel } from '../../../turn/usage-exhausted.js';
import Conf from 'conf';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { HarnessPrompter, PickerOption } from '../../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../../session/model.js';
import { readState } from '../../../session/state/read.js';
import { ephemeralSession } from '../../../session/ephemeral.js';
import { writeState } from '../../../session/state/write.js';
import { nativeUsageReading, recheckRecoveredAccounts } from '../../../harness/accounts/account-usage.js';
import { warmNativeModelCatalog } from '../../../harness/accounts/model-catalog.js';
import { usageResetLabel } from '../../../harness/accounts/usage-reading.js';
import { closePersistentTransport } from '../../../turn/vendor-process.js';
import { TERMINAL } from '../../../tui/active-terminal.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import { terminalUiSupported } from '../../../tui/capabilities.js';
import { activateSession, claimConversation, releaseConversationClaim, resolveSessionModel } from '../../../session/attach.js';
import { slashPalette } from '../../../tui/slash/registry.js';
import { sessionHarness, sessionOrProviderHarness, slashExtrasFor } from '../../../tui/slash/context.js';
import { autoSelectSessionHarness, interactiveEnginePicker } from '../../../tui/pickers/engine.js';
import { closeAllWorkerClients } from '../../../worker/turn-bridge.js';
import { retireStaleWorkers } from '../../../worker/client.js';
import { replaceCliWithNewBuild } from '../build-replace.js';
import { BOARD_OWNS } from './board.js';

/** What the loop reads and writes of the window while it runs, shared with
 * the setup's own timers: the conversation this window is on, and the
 * state its slash palette completes arguments from. */
interface WindowRef { id: string; paletteState: Pick<HarnessState, 'accounts' | 'sessions'> }

/** Everything the window's setup built, handed to the loop. */
export interface ChatWindow {
  config: Conf;
  /** The terminal UI; undefined on the plain readline path. */
  terminal: TerminalHarnessPrompter | undefined;
  rl: HarnessPrompter;
  ref: WindowRef;
  /** The conversation as it was when the window opened. */
  session: HarnessSession;
  slashCommandsFor: (target: HarnessSession) => PickerOption<string>[];
  warmCatalogFor: (target: HarnessSession, targetState: HarnessState) => void;
  refreshUsage: (target: HarnessSession, targetState: HarnessState, afterTurn?: boolean) => void;
  beginBuildReplace: () => Promise<void> | undefined;
  releaseWindow: () => Promise<void>;
}

/** The window's setup: the terminal, the conversation attached and claimed,
 * its first frame, the usage tick and the newer-build watch -- everything
 * that happens before the first line is read. Undefined when the
 * conversation vanished while it opened. */
export async function openWindow(config: Conf, startId: string): Promise<ChatWindow | undefined> {
  let id = startId;
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
  const ref: WindowRef = { id, paletteState: state };
  const slashCommandsFor = (target: HarnessSession): PickerOption<string>[] => {
    const harness = sessionHarness(target);
    return withArgValues(slashPalette(target, harness, { ...slashExtrasFor(target, harness), omit: BOARD_OWNS }), target, harness, ref.paletteState);
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
        if (selected && selected !== id) { id = selected; ref.id = id; }
      }
    } catch (error) {
      selectionNotice = error instanceof Error ? error.message : String(error);
    }
    // The picker and auto-select each ran their own read/write cycle, so the
    // snapshot above is stale. Adopt the current one wholesale.
    state = await readState({ transcripts: [id] });
    const next = state.sessions.find((item) => item.id === id);
    if (!next) return undefined;
    session = next;
  }
  // Any number of shells can have this same chat open; the shared worker
  // (worker/turn-bridge.ts) is what actually serializes turns, steering into
  // one already running rather than racing it. The presence record below is informational
  // bookkeeping only -- which shell most recently opened this chat -- never a
  // lock that keeps another shell from typing.
  if (activateSession(session)) await writeState(state);
  await resolveSessionModel(id);
  await claimConversation(id);
  state = await readState({ transcripts: [id] });
  const opened = state.sessions.find((item) => item.id === id);
  if (!opened) return undefined;
  session = opened;
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  const warmCatalogFor = createCatalogWarmer();
  warmCatalogFor(session, state);
  if (terminal) { terminal.render(session, initialAccount); if (selectionNotice) terminal.activity(selectionNotice); }
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = createUsageRefresher(config, terminal);
  refreshUsage(session, state);
  const { beginBuildReplace, releaseWindow } = startBuildWatch(terminal, ref, refreshUsage);
  return { config, terminal, rl, ref, session, slashCommandsFor, warmCatalogFor, refreshUsage, beginBuildReplace, releaseWindow };
}


/** Warm `/model` while the composer is up, so the first open is not a wait.
 * Re-warmed when the chat's provider or account changes (see the loop). */
function createCatalogWarmer(): ChatWindow['warmCatalogFor'] {
  let warmedCatalogKey = '';
  return (target: HarnessSession, targetState: HarnessState): void => {
    const key = `${target.nativeHarness ?? ''}\0${target.provider ?? ''}\0${target.accountId ?? ''}`;
    if (key === warmedCatalogKey) return;
    warmedCatalogKey = key;
    const harness = sessionOrProviderHarness(target);
    warmNativeModelCatalog(harness, target.accountId ? targetState.accounts.find((item) => item.id === target.accountId) : undefined);
  };
}

/** The status line's usage: the Gateway's credit, or the account's reading. */
function createUsageRefresher(config: Conf, terminal: TerminalHarnessPrompter | undefined): ChatWindow['refreshUsage'] {
  return (target: HarnessSession, targetState: HarnessState, afterTurn = false): void => {
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
}

/** Watch for a newer build on disk and keep the usage fresh: the 15 s tick and the two ways out of the window. */
function startBuildWatch(
  terminal: TerminalHarnessPrompter | undefined, ref: WindowRef, refreshUsage: ChatWindow['refreshUsage'],
): Pick<ChatWindow, 'beginBuildReplace' | 'releaseWindow'> {
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
    await closeAllWorkerClients().catch(() => undefined);
    await closePersistentTransport().catch(() => undefined);
    // Nothing it showed keeps a local model up, even if this process lives
    // on (the exit hook covers a hard exit).
    await reconcileLocalModelLeases(undefined).catch(() => undefined);
  };
  const newerBuild = (): boolean => Boolean(startupBuild && currentWorkerBuild() !== startupBuild);
  const beginBuildReplace = (): Promise<void> | undefined => {
    if (!terminal || !newerBuild()) return undefined;
    const sessionId = ref.id;
    const draft = ephemeralSession(sessionId);
    return replaceCliWithNewBuild({
      sessionId,
      ...(draft ? { draft } : {}),
      closeUi: () => terminal.close(),
      release: async () => {
        await releaseWindow();
        // The chat stays. Discarding a blank one here would make the new
        // process's `sessions resume` miss it.
        await releaseConversationClaim(sessionId).catch(() => undefined);
      },
    });
  };
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
    // Only a terminal being looked at asks: every open window asking every
    // 15 s was a vendor process and an index write per account, per window.
    // The first tick after focus comes back catches up.
    if (terminal.lookedAway()) return;
    void readState({ transcripts: [] }).then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === ref.id);
      if (latest) refreshUsage(latest, latestState);
      // The other accounts too, but only one whose quota may have come back:
      // otherwise an account that ran out showed its last "0% left" until
      // someone happened to open the picker, and read as spent for hours.
      return recheckRecoveredAccounts(latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
    // How soon the status line shows a turn another terminal ran on this
    // account, or a window that reset.
  }, 15_000) : undefined;
  return { releaseWindow, beginBuildReplace };
}
