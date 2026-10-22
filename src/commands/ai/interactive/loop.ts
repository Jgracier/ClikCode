/** The window loop. */
import { queuedNext } from '../../../session/queue-next.js';
import { diagnostic } from '../../../runtime/lifecycle-log.js';
import { beginTurnClock, endTurnClock, markTurn } from '../../../runtime/turn-latency.js';
import { randomUUID } from 'node:crypto';
import { isClikCodeAgent } from '../../../session/route.js';
import { reconcileLocalModelLeases } from '../local-model.js';
import { isShellCommandLine } from '../shell-run.js';
import type { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import type { HarnessSession, HarnessState } from '../../../session/model.js';
import { readState } from '../../../session/state/read.js';
import { writeState } from '../../../session/state/write.js';
import { consumeSessionTurn } from '../../../turn/checkpoint.js';
import { closePersistentTransport, nativeAvailableCommands } from '../../../turn/vendor-process.js';
import { synchronizeNativeTranscript } from '../../../turn/handoff.js';
import { TERMINAL } from '../../../tui/active-terminal.js';
import { claimConversation, leaveConversation } from '../../../session/attach.js';
import { newConversation } from '../conversations.js';
import { dispatchLine } from '../../../tui/slash/dispatch.js';
import { stopWaitingForReset, type ExhaustionRetryGuard } from '../../../tui/pickers/resume-in.js';
import { followWorkerTurn, prepareSessionWorker, pushSessionSettings, questionOrWorker, refreshSessionWorker, releaseSessionWorker, workerQueueMark, workerTurn } from '../../../worker/turn-bridge.js';
import { shownSettingsKey } from '../../../worker/protocol.js';
import { liveSettingsOf } from '../../../turn/live-settings.js';
import { BOARD_LINE, DELETED_ELSEWHERE, joinedTurn } from './board.js';
import { turnFailureEffect } from './turn-failure.js';
import { runTimedTurn } from './run-turn.js';
import { createSlashHost, openConversationPicker, runShellInChat } from './slash-host.js';
import type { ChatWindow } from './window.js';
import { runRemoteChat, type RemoteChatSelection } from '../../../remote/terminal-chat.js';
import { openedChat } from '../../../remote/move-terminal.js';

/** What one read of the next line came to: another pass, the end of the loop, or a line to run. */
type NextLine = 'continue' | 'exit' | PickedLine;
interface PickedLine { line: string; queuedTurnId: string | undefined; fromQueuedCommand: boolean }

/** The loop of a window: read a line (or follow a turn another window runs), then run it as a turn, a shell line or a slash command, until the user leaves. */
export class ChatLoop {
  /** The conversation as this window last read it: what a fresh one copies
   * its setup from when this one is deleted under it. */
  private lastSeen: HarnessSession;
  /** A message to send next, without asking: the one that ran out of usage,
   * after "Resume in" moved the chat to a harness that has some. */
  private resend: string | undefined;
  /** Left was pressed during a turn: the board opens next, with the turn
   * still running behind it (see startWaiting's onLeave). */
  private openBoard = false;
  /** The same-provider retry after running out, at most once per
   * interrupted turn, so a record that keeps flipping cannot loop. */
  private readonly exhaustionGuard: ExhaustionRetryGuard = {};
  private synchronizedSessionId = '';
  private transportSessionId: string;
  /** `<session id> <route>` this terminal last prepared a worker for. */
  private preparedRoute: string | undefined;
  /** What this terminal last read of the conversation's settings: a change
   * between two reads (a /account, /model, sign-in) is sent to the worker so
   * every other window attached to it re-renders. */
  private shownSettings: string | undefined;
  private shownLiveSettings: string | undefined;
  /** One line for the transcript after the next frame: the answer to a command the user just ran. */
  private notice: string | undefined;
  /** /exit was typed in a chat on another machine: this window closes. */
  private leaving = false;
  /** What this pass's turn actually sent, when a slash command expanded
   * the line (/review): what an interrupted turn recorded is compared to. */
  private sentPrompt: string | undefined;
  private readonly terminal: ChatWindow['terminal'];
  private readonly rl: ChatWindow['rl'];
  private readonly config: ChatWindow['config'];
  private readonly slashCommandsFor: ChatWindow['slashCommandsFor'];
  private readonly warmCatalogFor: ChatWindow['warmCatalogFor'];
  private readonly refreshUsage: ChatWindow['refreshUsage'];
  private readonly beginBuildReplace: ChatWindow['beginBuildReplace'];
  private readonly releaseWindow: ChatWindow['releaseWindow'];

  constructor(private readonly w: ChatWindow) {
    ({ terminal: this.terminal, rl: this.rl, config: this.config, slashCommandsFor: this.slashCommandsFor, warmCatalogFor: this.warmCatalogFor,
      refreshUsage: this.refreshUsage, beginBuildReplace: this.beginBuildReplace, releaseWindow: this.releaseWindow } = w);
    this.lastSeen = w.session;
    this.transportSessionId = w.ref.id;
  }

  /** The conversation this window is on: shared with the setup's timers. */
  private get id(): string { return this.w.ref.id; }
  private set id(value: string) { this.w.ref.id = value; }

  /** A turn failed: what it changes is decided in turn-failure.ts, applied here. */
  private async handleTurnFailure(error: unknown, failed: { line?: string; sent?: string; queuedTurnId?: string }): Promise<void> {
    const effect = await turnFailureEffect({ terminal: this.terminal, id: this.id, guard: this.exhaustionGuard, refreshUsage: this.refreshUsage }, error, failed);
    if ('notice' in effect) this.notice = effect.notice;
    if ('resend' in effect) this.resend = effect.resend;
    if (effect.id !== undefined) this.id = effect.id;
  }

  async run(): Promise<void> {
    const { terminal, rl, releaseWindow } = this;
    try {
      // Opened (--resume, --continue) on a copy that moved: the live chat instead.
      if (terminal) await this.followMoved(terminal);
      while (!this.leaving) {
        this.sentPrompt = undefined;
        // One live Codex/ACP child per OPEN conversation: leaving it (new chat,
        // fork, resume) closes the child it had.
        if (this.transportSessionId !== this.id) {
          const leaving = this.transportSessionId;
          nativeAvailableCommands.delete(leaving);
          this.transportSessionId = this.id;
          // The next chat paints while the vendor child it left finishes closing.
          void closePersistentTransport(leaving);
        }
        const next = await this.readNext();
        if (next === 'exit') break;
        if (next === 'continue') continue;
        if (await this.handleLine(next) === 'exit' || this.leaving) break;
      }
    } finally {
      await releaseWindow();
      // Hand the conversation back so the next terminal can resume it, and do
      // not store one closed without ever being started. Best effort: a failed
      // release only means the record goes stale on its own.
      await leaveConversation(this.id);
      if (TERMINAL.active === terminal) TERMINAL.active = undefined;
      rl.close();
    }
  }

  private async readNext(): Promise<NextLine> {
    try {
      return await this.readNextInner();
    } catch (error) {
      // A non-interactive caller may close stdin after its final command.
      // Treat that exactly like leaving the foreground harness, not a crash.
      if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') return 'exit';
      throw error;
    }
  }

  private async readNextInner(): Promise<NextLine> {
    const { terminal, refreshUsage } = this;
    const queueMark = terminal ? await workerQueueMark(this.id) : undefined;
    const latestState = await readState({ transcripts: [this.id] });
    const latest = latestState.sessions.find((item) => item.id === this.id);
    if (!latest) {
      // Deleted while open (another window's board, `clikcode sessions`):
      // this window carries on in a fresh conversation set up the same
      // way, and says so. Leaving ClikCode is never the answer to that.
      this.id = await newConversation(this.lastSeen.id, { sameModel: true, lastSeen: this.lastSeen });
      await claimConversation(this.id).catch(() => undefined);
      diagnostic('window.conversation-deleted', DELETED_ELSEWHERE);
      return 'continue';
    }
    const account = await this.prepareRound(latest, latestState);
    const running = terminal ? await workerTurn(latest.id) : undefined;
    terminal?.render(latest, account, running ? { running: true, following: true, ...running } : { running: false });
    // After a turn or a command: a Gateway balance a turn just billed.
    refreshUsage(latest, latestState, true);
    // What the last pass has to say goes into the transcript, as a line.
    if (this.notice) terminal?.activity(this.notice);
    this.notice = undefined;
    if (this.synchronizedSessionId !== this.id) {
      const syncId = this.id;
      this.synchronizedSessionId = syncId;
      // The vendor file is reconciled after the chat is on screen. Merging
      // it first is what made Enter wait on a CLI that was not this turn.
      void synchronizeNativeTranscript(latestState, latest).then(async (changed) => {
        if (!changed || syncId !== this.id) return;
        await writeState(latestState);
        if (syncId === this.id) terminal?.render(latest, account, running ? { running: true, ...running } : { running: false });
      }).catch(() => undefined);
    }
    return this.pickLine(latest, latestState, account, running, queueMark);
  }

  private async prepareRound(latest: HarnessSession, latestState: HarnessState): Promise<string | undefined> {
    const { terminal, warmCatalogFor, refreshUsage } = this;
    this.lastSeen = latest;
    warmCatalogFor(latest, latestState);
    // Whatever the last command or turn did to the conversation this
    // terminal shows, it holds a local model for that one alone.
    await reconcileLocalModelLeases(latest);
    // The same for ClikCode's own agent: a conversation that is now on the
    // Gateway (or ClikCode Local) has its MCP servers started and the
    // Gateway connection opened before the first message; one that moved
    // to a vendor harness, or that this terminal left, stops them.
    const routeKey = `${latest.id} ${latest.route}`;
    if (routeKey !== this.preparedRoute) {
      const leftId = this.preparedRoute?.split(' ')[0];
      if (leftId && leftId !== latest.id) releaseSessionWorker(leftId);
      this.preparedRoute = routeKey;
      void prepareSessionWorker(latest.id, { spawn: isClikCodeAgent(latest) }).catch(() => undefined);
    }
    const settingsKey = shownSettingsKey(latest);
    if (this.shownSettings?.startsWith(`${latest.id}|`) && this.shownSettings !== settingsKey) refreshSessionWorker(latest.id);
    this.shownSettings = settingsKey;
    // What a running turn reads (permission mode, speed too): pushed to its worker when it changed.
    const liveKey = `${latest.id}|${JSON.stringify(liveSettingsOf(latest))}`;
    if (this.shownLiveSettings?.startsWith(`${latest.id}|`) && this.shownLiveSettings !== liveKey) pushSessionSettings(latest);
    this.shownLiveSettings = liveKey;
    const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
    this.w.ref.paletteState = latestState;
    // A turn parked for the quota reset: Esc on an empty composer stops it.
    if (terminal) {
      const parkedId = latest.id;
      terminal.idleEscape = latest.resumeAt ? () => {
        void stopWaitingForReset(parkedId).then((stopped) => {
          if (!stopped) return;
          refreshSessionWorker(parkedId);
          delete latest.resumeAt;
          terminal.render(latest, account, { running: false });
          refreshUsage(latest, latestState);
        }).catch(() => undefined);
      } : undefined;
    }
    return account;
  }

  /** The turn the worker is running, followed to its end and shown as
   * this window shows its own turns: the prompt as the pending message
   * over the conversation, then the answer. `resendText` is what running
   * out of usage offers to send again. */
  private async followRunning(terminal: TerminalHarnessPrompter, latest: HarnessSession, account: string | undefined, prompt: string | undefined, resendText: string | undefined): Promise<void> {
    terminal.holdPaints();
    terminal.submitted(prompt);
    terminal.render(latest, account, { running: true, ...(prompt !== undefined ? { prompt } : {}) });
    let left = false;
    try {
      const followed = await followWorkerTurn(latest.id, terminal, joinedTurn(latest, prompt));
      left = Boolean(followed.left);
      if (left) this.openBoard = true;
    } catch (error) {
      await this.handleTurnFailure(error, { line: resendText });
    } finally {
      // Normally released once the turn is drawn (followWorkerTurn); this is for a follow that never
      // got there. Not when it was left for the board: that hold is the board's to end (leaveTurn).
      if (!left) terminal.releasePaints();
    }
  }

  private async pickLine(
    latest: HarnessSession, latestState: HarnessState, account: string | undefined, running: Awaited<ReturnType<typeof workerTurn>>, queueMark: Awaited<ReturnType<typeof workerQueueMark>> | undefined,
  ): Promise<NextLine> {
    const { terminal, rl, slashCommandsFor, beginBuildReplace } = this;
    let line: string;
    let queuedTurnId: string | undefined;
    /** This line was already handed to the loop once. Anything below that
     * would hand it back must not, or a cancelled picker loops forever. */
    let fromQueuedCommand = false;
    let queued = latest.queuedTurns?.[0];
    // A turn that ended stopped: the messages queued behind it do not run on
    // their own (it would look as if the Stop failed). They come back to the
    // composer, and the user decides.
    if (terminal?.takeStopped() && !running && !this.openBoard && queued && queued.kind !== 'command' && queued.kind !== 'notification') {
      const back: string[] = [];
      for (const entry of [...(latest.queuedTurns ?? [])]) {
        if (entry.kind === 'command' || entry.kind === 'notification') continue;
        if (consumeSessionTurn(latest, entry.id)) back.push(entry.text);
      }
      if (back.length) {
        await writeState(latestState);
        terminal.restoreDraft([terminal.queuedDraft, ...back].filter(Boolean).join('\n'));
      }
      queued = latest.queuedTurns?.[0];
    }
    if (this.openBoard) {
      // Before anything that would follow the running turn straight back.
      this.openBoard = false;
      line = BOARD_LINE;
    } else {
      // A turn is running (another window's, or one the worker started):
      // the queued message waits behind it, so that turn is followed to its
      // end rather than the message sent into it only to be queued again.
      const next = queuedNext(latest);
      const runningTurn = next?.kind === 'message' ? running : undefined;
      if (runningTurn && terminal) {
        // Running out offers to carry on THAT turn (its prompt), and the
        // message queued behind it goes with the conversation -- offering
        // the queued text instead ran it on the branch while it also stayed
        // queued here.
        await this.followRunning(terminal, latest, account, runningTurn.prompt, runningTurn.prompt ?? latest.pendingTurn?.prompt);
        return 'continue';
      }
      if (this.resend) {
        // The turn that ran out, carried on: it came before anything
        // queued behind it, which "Resume in" moved here with it.
        line = this.resend;
        this.resend = undefined;
      } else if (next?.kind === 'command') {
        fromQueuedCommand = true;
        // A slash command typed while the turn was running. It runs as the
        // command it is, with the screen to itself -- which is why it waited
        // rather than running mid-stream. Consumed first: a command that
        // throws must not be retried forever on every later pass.
        line = next.entry.text;
        if (consumeSessionTurn(latest, next.entry.id)) await writeState(latestState);
      } else if (next) {
        // No notice: a queued message is echoed into the conversation as the
        // user message it is, and the waiting row underneath says a turn is
        // running. Announcing it a third time said nothing the screen did
        // not already say.
        line = next.entry.text;
        queuedTurnId = next.entry.id;
      } else if (terminal) {
        // A turn just ended, or the prompt is coming back. Do not wait out
        // the usage tick to pick up a build that landed during the turn.
        if (terminal.idleForBuildReplace()) {
          const leaving = beginBuildReplace();
          if (leaving) { await leaving; return 'exit'; }
        }
        // The worker may start a turn while this sits here (another
        // window's, or a follow-up for a finished background shell), or
        // queue something: either ends the prompt, keeping the draft.
        const answer = await questionOrWorker(latest.id, (signal) => terminal.question('› ', slashCommandsFor(latest), { rightArrowPalette: true, leftArrowCommand: BOARD_LINE, ...(signal ? { signal } : {}) }), queueMark);
        if ('woke' in answer) {
          if (answer.woke === 'turn') await this.followRunning(terminal, latest, account, answer.prompt, answer.prompt);
          return 'continue';
        }
        line = answer.line.trim();
      } else line = (await rl.question('› ', slashCommandsFor(latest), { rightArrowPalette: true, leftArrowCommand: BOARD_LINE })).trim();
    }
    return { line, queuedTurnId, fromQueuedCommand };
  }

  /** One turn with the normal waiting / cancel / live-input UI. `echo`
   * paints the submitted text as the pending user message; synthetic
   * prompts (/review, /init, /compact) are not shown as if typed. */
  private async runInteractiveTurn(targetId: string, promptText: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> {
    const { terminal, config } = this;
    // The turn's latency clock starts here, at Enter (runtime/turn-latency.ts):
    // the worker is handed its turn id and start so both processes measure
    // from the same moment.
    const turnId = randomUUID();
    const submittedAt = Date.now();
    beginTurnClock({ turnId, startedAt: submittedAt, ...(this.lastSeen.id === targetId ? { harness: this.lastSeen.nativeHarness ?? this.lastSeen.route } : {}) });
    markTurn('submit');
    try {
      this.sentPrompt = promptText;
      const result = await runTimedTurn({ config, terminal, lastSeen: this.lastSeen }, targetId, promptText, { ...turn, turnId, submittedAt });
      if (result.left) this.openBoard = true;
    } finally {
      endTurnClock(turnId);
    }
  }

  /** A chat on another machine, in this window, until it comes back to one here. */
  private async openRemote(terminal: TerminalHarnessPrompter, selection: RemoteChatSelection, draft?: string, hops = 0): Promise<void> {
    await leaveConversation(this.id);
    try {
      const end = await runRemoteChat(terminal, this.id, selection, draft);
      if (typeof end === 'object') { this.leaving = true; return; }
      if (end) this.id = end;
    } finally {
      await claimConversation(this.id).catch(() => undefined);
    }
    // The chat it comes back to may be a copy that moved (picked on the board there).
    await this.followMoved(terminal, hops + 1);
  }

  /** This window's chat, when it is a copy that moved to another machine: the
   * live one is opened in its place, wherever it is (move-terminal.ts liveChat).
   * True when that was a chat on another machine, shown until it was left. */
  private async followMoved(terminal: TerminalHarnessPrompter, hops = 0): Promise<boolean> {
    if (hops > 8) return false;
    const live = await openedChat(this.id);
    if (!live) return false;
    if (live.notice) this.notice = live.notice;
    if ('remote' in live.here) { await this.openRemote(terminal, live.here.remote, undefined, hops); return true; }
    if (live.here.local === this.id) return false;
    await leaveConversation(this.id);
    this.id = live.here.local;
    await claimConversation(this.id).catch(() => undefined);
    return false;
  }

  private async handleLine(next: PickedLine): Promise<'exit' | undefined> {
    const { terminal, rl, config, beginBuildReplace } = this;
    const { queuedTurnId, fromQueuedCommand } = next;
    let { line } = next;
    if (!line) return;
    // Left on an empty prompt: the board, through the handler /resume has.
    const viaBoard = line === BOARD_LINE;
    if (viaBoard) line = '/resume';
    try {
      // A queued live-composer submission is always conversation text. A
      // leading slash or path in it must not turn into a local command when
      // it is automatically dispatched after the active turn.
      if (queuedTurnId) {
        await this.runInteractiveTurn(this.id, line, { echo: true, queuedTurnId });
        return;
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
          this.notice = 'Type `!<command>` to run it and give the model its output, e.g. `!git status`.';
          return;
        }
        await runShellInChat(terminal, this.id, command, this.lastSeen);
        return;
      }
      const host = createSlashHost({
        config, rl, terminal,
        runTurn: (targetId, promptText) => this.runInteractiveTurn(targetId, promptText, { echo: false }),
        openConversationPicker: () => openConversationPicker({ config, rl, terminal, beginBuildReplace }, this.id),
      });
      const outcome = await dispatchLine(host, this.id, line, { fromQueuedCommand });
      if (outcome.notice) this.notice = outcome.notice;
      if (outcome.exit) return 'exit';
      if (outcome.remote && terminal) {
        await this.openRemote(terminal, outcome.remote, outcome.draft);
        return;
      }
      if (outcome.id && outcome.id !== this.id) {
        // Leaving a chat nothing happened in: it does not stay behind.
        await leaveConversation(this.id);
        this.id = outcome.id;
        await claimConversation(this.id).catch(() => undefined);
        // A copy that moved (/resume <id>, a fork's row): the live chat instead.
        if (terminal && await this.followMoved(terminal)) return;
      }
      if (outcome.draft !== undefined) terminal?.restoreDraft(outcome.draft);
      if (outcome.prompt) await this.runInteractiveTurn(this.id, outcome.prompt, { echo: outcome.echo !== false });
    } catch (error) {
      // The conversation was deleted under this window: what was typed
      // stays in the composer, for the fresh one the next pass opens.
      if (!(await readState({ transcripts: [] })).sessions.some((item) => item.id === this.id)) {
        terminal?.submitted(undefined);
        if (!viaBoard) terminal?.restoreDraft(line);
        return;
      }
      // A queued message is handed back, and one that ran out of usage is
      // offered "Resume in" as a typed one is.
      await this.handleTurnFailure(error, { line, sent: this.sentPrompt ?? line, ...(queuedTurnId ? { queuedTurnId } : {}) });
    }
  }
}

