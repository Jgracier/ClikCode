/** The interactive terminal, drawn on the alternate screen: the conversation
 * as a transcript this UI keeps and scrolls itself, and below it one live
 * region holding the changing response, controls and composer. Every row is
 * written at an address, and a frame writes only the rows that changed. */

import chalk from 'chalk';
import { lifecycle, setLifecycleSession } from '../runtime/lifecycle-log.js';
import type { LoginLink, SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../gateway/login/url.js';
import { pastedText } from './keys.js';
import { backslashNewline, composerVerticalMove, editComposer, editWaitingComposer } from './composer-edit.js';
import { commandPaletteMatches, completedCommandLine, composerRightArrowValue, exactPaletteCommand, type PaletteEntry } from './command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { composerLayout } from './render/composer-layout.js';
import { closeOpenHyperlink } from './render/hyperlinks.js';
import { createStreamingBlockParser } from './render/markdown.js';
import { sanitizeTerminalText } from './render/text.js';
import { nextCharacterIndex, previousCharacterIndex, terminalCellWidth, visibleSlice, visibleTail } from './render/width.js';
import { installTerminalRestoreSignals, REEXEC_TERMINAL_ENV, restoreTerminal, signalsTeardown, terminalModes, terminalPrepare, terminalTeardown } from './restore.js';
import { PUSH_TITLE, notifySequence, progressSequence, shouldNotify, titleSequence, windowTitle, type FocusState } from './terminal-signals.js';
import { compactPath, sessionProviderLabel } from '../harness/protocol/labels.js';
import { stripRepeatedTitles } from '../session/title.js';
import { isGatewayService } from '../session/route.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { sessionTranscriptMessages, settledTranscriptMessages } from '../turn/checkpoint.js';
import { readTurnActivities } from '../turn/turn-activities.js';
import { TurnTranscript, type SettlingTool } from '../turn/transcript.js';
import { nativeModelLabel } from '../harness/accounts/model-catalog.js';
import { localModelLabel } from '../local-models/catalog.js';
import type { LiveTurnInputResult, TakeBackOutcome } from '../turn/live-input.js';
import type { HarnessActivityEvent, HarnessPrompter, JournalState, MessageBlock, PickerOption, PickerSettings, ToolCategory } from '../harness/prompter.js';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { ActivityEntry, collapseToolRuns, activityLifecyclePhase, openToolsStatus, rebaseActivityOffsets, transientAssistantRequired, upsertActivityEvent } from './render/activity-log.js';
import { outputPreviewRows, renderActivityLine } from '../harness/protocol/activity-line.js';
import { toolUses, withChildTool, joinTurnClock, nextTurnTickMs, pauseTurnClock, resumeTurnClock, startTurnClock, turnAnimating, turnElapsedMs, type OpenTool, type TurnClock, type TurnWaits } from '../harness/protocol/activity-view.js';
import { logProcessWarnings } from './warnings.js';
import { tensedLabel, turnStatus, endsWithSummary, turnSummary } from '../harness/protocol/turn-flow.js';
import { paintStatus } from './render/status-line.js';
import { expandPastes, insertPaste, keptPastes, removePlaceholderAt, type DraftWithPastes, type HeldPaste } from './render/held-pastes.js';
import { ExploreGrouping, mergedExploreLines, mergedExploreSummaryLine, type GroupRow, type TurnGroup } from './render/explore-groups.js';
import { TOOL_CATEGORY_STYLE } from '../harness/protocol/tool-category-style.js';
import { NOTICE_MS, PAINT_COALESCE_MS } from '../harness/protocol/timings.js';
import { APPROVAL_GUARD_MS, ApprovalPreview, ApprovalRequest, approvalBlockRows, approvalKeyAction } from './render/approval-block.js';
import { frameRowBudget } from './render/frame-budget.js';
import { paletteRows as paletteBandRows, panelRows as panelBandRows } from './render/footer-rows.js';
import { runOptionPicker, type OptionPickerHost } from './option-picker.js';
import { runConversationBoard, type BoardResult, type ConversationBoardSettings } from './conversation-board.js';
import { EmittedTranscript } from './render/emitted-transcript.js';
import { reseedStartIndex } from './render/reseed-window.js';
import { hasDurableSteer, STEER_WORDS, steerTranscriptRows } from './render/steer-rows.js';
import { pendingPromptText } from './render/pending-prompt.js';
import { highlightWords, rowOfOccurrence, type MentionFocus } from './render/search-focus.js';
import { highlightSelectionAt, lineAtRow, lineText, orderedRange, scrollShift, selectedText, selectionAction, selectionIsEmpty, shiftedRow, type MouseAction, type Selection } from './render/selection.js';
import { copyToClipboard } from '../session/attachments.js';
import { commandLineTypedDuringTurn } from './waiting-slash.js';
import { messageRows as cachedMessageRows, noticeRows as clikCodeNoticeRows, renderMessageBlocks } from './render/message-blocks.js';
import { isClikCodeNotice } from '../session/clikcode-notice.js';
import { reducedMotion } from './capabilities.js';
import { logCursorEvent } from './cursor-log.js';
import { KEEP_STDIN_FLOWING, inKeyBatch, onKeyBatchEnd, onTerminalFocus, takeTerminalKeys, waitingEnterAction, waitingInputAction } from './input-decoder.js';
import { SWIPE_ROWS, enterInputModes, isMouseEvent, popReadModes, redrawPreamble, sessionModesOff, sessionModesOn, setTerminalRawMode, takeQueuedModes, wheelScrollRows, type Redraw } from './modes.js';
import { PlanEntry, planBlockRows } from './render/plan-block.js';
import { estimatedTokens, formatTurnUsage } from './render/usage-line.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { appendThought, composerUsageLabel, liveConversationLines, liveWaitKind, paintTitleRule, paintUsageRule, runningChatLine, waitingSpinnerGlyph, type Thought } from './render/waiting.js';
import { formatElapsed } from '../harness/protocol/format.js';
import { keyHint } from '../harness/protocol/wording.js';
import type { SendMode } from '../turn/send-mode.js';
import { userError } from '../harness/protocol/errors.js';

const EXIT_CONFIRM_MS = 2000;

/** How long a resize burst is given to finish before the settled redraw. A
 * phone dismissing its keyboard emits several SIGWINCHes a few tens of
 * milliseconds apart; this is longer than that gap. The first size of a
 * burst is drawn at once (onResize); this only decides when the burst is over. */
const RESIZE_SETTLE_MS = 120;

/** The least a pending scroll moves in one frame, so a drain always finishes.
 * Claude Code's value. */
const SCROLL_DRAIN_MIN = 4;

/** One frame, roughly: the gap between drains of an outstanding scroll. */
const SCROLL_DRAIN_MS = 16;

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';

/** Rows kept above the viewport so scrolling back inside a conversation still
 * has somewhere to scroll to. */
const ALTERNATE_TRANSCRIPT_ROWS = 2000;
/** How often a drag held at the screen's edge scrolls the selection a line. */
const SELECTION_SCROLL_MS = 60;

/** Lines of a running tool's newest output shown under its spinner. */
const LIVE_OUTPUT_LINES = 3;

/** One paint's composer: its text and cursor, the prompt, and the options
 * (a picker's list or the slash palette) under it. */
type ComposerFrame = {
  text: string; options: readonly PickerOption<string>[]; selected: number; prompt: string; cursor: number;
  palette?: { capacity?: number; hint?: string; hideCursor?: boolean };
};
const EMPTY_COMPOSER: ComposerFrame = { text: '', options: [], selected: 0, prompt: '› ', cursor: 0 };

/** Everything that exists only while a turn (or another wait: a download, a
 * shell command) is in flight. startWaiting creates it whole and stopWaiting
 * drops it whole, so no piece of one turn's state can outlive it into the
 * next. Its presence is what "running" means to the rest of the prompter. */
type WaitingTurn = {
  /** What the band says the turn is doing. */
  label: string;
  /** Elapsed less approvals, and the last delta or event, which is what
   * "stalled" means (see activity-view.ts). */
  clock: TurnClock;
  /** When the current stretch of thinking began -- the turn's start, or the
   * last call finishing or answer text arriving -- for turnStatus's words. */
  thinkingSince: number;
  /** The composer typed into while the turn runs. */
  draft: string;
  cursor: number;
  /** Ctrl+C, or Enter again on a waiting message, has asked the turn to stop. */
  cancelled: boolean;
  cancel?: (restoreDraft: boolean) => void;
  /** Take a waiting message back out of the queue (Esc): `removed` only when
   * it is the user's again -- not already on its way into the turn. */
  takeBack?: (id: string) => Promise<TakeBackOutcome>;
  /** Absent for a wait that takes no messages. */
  submit?: (text: string) => Promise<LiveTurnInputResult>;
  command?: (text: string) => Promise<LiveTurnInputResult>;
  /** Stop showing the running turn without stopping it (Left, empty draft). */
  leave?: () => void;
  timer?: NodeJS.Timeout;
  stopInput?: () => void;
  /** Drawn before the turn's own controls exist (turnStarting): what is
   * typed is kept for it, and an interrupt is passed on once it can be. */
  early?: { interrupt?: { restoreDraft: boolean } };
  /** Told when this turn's display ends, by whoever ends it: the follow of a
   * worker's turn (worker/turn-bridge.ts) lives exactly as long as the
   * display it drives. When the two could disagree, the display ended and the
   * follow kept waiting for the worker -- nothing read a key until the
   * worker's turn ended, an hour on with sub-agents running. */
  ended?: () => void;
};

export class TerminalHarnessPrompter implements HarnessPrompter {
  private closed = false;
  private history: string[] = [];
  private currentSession?: HarnessSession;
  private currentNotice?: string;
  /** The composer as the last paint drew it, for repaint() to draw again. */
  private composer: ComposerFrame = EMPTY_COMPOSER;
  /** The turn (or other wait) in flight: see WaitingTurn. */
  private turn?: WaitingTurn;
  private waitingFrame = 0;
  /** Whether the pending tick is the spinner's (true) or the clock's. */
  private waitingTickFast = false;
  /** Characters of answer and reasoning streamed this turn, and how many of
   * them the vendor's last output-token count already covers. */
  private streamedChars = 0;
  private usageCharsCounted = 0;
  private activityEntries: ActivityEntry[] = [];
  /** A link sign-in's link and code, drawn above the waiting band while it
   * runs (linkWait). */
  private signInLines: string[] = [];
  /** What the waiting composer is for while a sign-in asks for a code or a
   * key: Enter hands the draft here instead of to the turn. */
  private signInInput?: { secret: boolean; submit: (text: string) => void };
  /** A sign-in is up: the wait is on the user, in their browser, so the band
   * holds still as it does for an approval -- the clock ticks, nothing spins. */
  private signingIn = false;
  /** collapseToolRuns over activityEntries, redone only when they change. */
  private collapsedActivity?: { source: readonly ActivityEntry[]; entries: ActivityEntry[] };
  /** The calls still open: the status line names the newest (toolStatus). */
  private activeTools = new Map<string, OpenTool>();
  /** The latest call inside a running sub-agent, keyed by the parent tool id.
   * Shown as one line under that agent, never as its own row. */
  private childActivity = new Map<string, string>();
  /** Which of this turn's reads and searches share a row (explore-groups.ts). */
  private readonly exploreGrouping = new ExploreGrouping();
  private liveResponse = '';
  private responsePaintTimer?: NodeJS.Timeout;
  private frameInFlight = false;
  /** Why the next frame that draws rows is drawn, when it is not routine:
   * after a resize, or a repair (Ctrl+L). See redrawPreamble. */
  private pendingRedraw: Redraw | undefined;
  private queuedDraft?: string;
  /** A message typed and sent (Enter) under a sign-in's own wait, and any
   * keys after it: typed into the prompt that opens next, as if typed there,
   * so it is sent -- the wait has no turn to send it to. */
  private typedAhead: string[] = [];
  /** A sign-in's wait just ended: what was typed under it goes on into the
   * turn that starts next (startWaiting). */
  private signedInJustNow = false;
  /** The turn this window stepped out of (leaveTurn), still running in its
   * worker. What it already wrote to scrollback is remembered here, nothing
   * more of it is drawn while away, and following the same turn again
   * carries on from where scrollback stops. */
  private steppedOut?: { sessionId: string; prompt?: string; anchor: number };
  /** The highest index of the running turn's activities already shown (see
   * activityEvent's `live`), so replaying them on a (re)join adds only the
   * ones this window has not seen. */
  private liveActivitiesShown = -1;
  /** What the last render said about `currentSession`'s journal. */
  private journal: JournalState = { running: true };
  /** `id` arrives with the answer to the submission, and is the same id its
   * durable copy (a queued turn, a recorded steer) is stored under. */
  private waitingSubmissions: Array<{ localId: number; id?: string; text: string; responseOffset: number; sequence: number; state: 'sending' | 'queued' | 'steered' | 'error' | 'command'; unsteered?: boolean }> = [];
  /** `/send`: what Enter on a message mid-turn does, as the band says it. */
  private sendMode: SendMode = 'steer';
  private waitingSubmissionId = 0;
  private timelineSequence = 0;
  private readonly waitingSubmissionWrites = new Set<Promise<void>>();
  private suspended = false;
  private readonly reducedMotion = reducedMotion();
  private activityAnchor = 0;
  /** Rows retired since the last frame reached the terminal, and the live
   * region that frame will draw below them. */
  private pendingFinished: string[] = [];
  private pendingLive?: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean };
  /** The last row retired, so a blank separator is never doubled across the
   * boundary between one frame and the next. */
  private lastFinishedRow?: string;
  /** The row before it, so the guard that separates messages can tell one
   * empty row from two across a frame boundary. */
  private secondLastFinishedRow?: string;
  private readonly turnTranscript = new TurnTranscript();
  /** What is already in the transcript. See emitted-transcript.ts: a retired
   *  row is never rewritten in place, so the rules live in one place. */
  private readonly emitted = new EmittedTranscript();
  /** The width the transcript's rows were wrapped at. A resize to another
   * width wraps the whole conversation again (see rewrapTranscript). */
  private transcriptColumns = output.columns || 0;
  private usageLabel?: string;
  private usageResetLabel?: string;
  private selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever composer.options happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  private paletteActive = false;
  /** A mouse selection in progress, in conversation lines, not screen rows
   * (see lineAtRow): a drag that scrolls the view keeps what it selected, and
   * one longer than the screen copies whole. */
  private selection?: Selection;
  /** While a drag rests on the top or bottom edge, the view keeps scrolling
   * that way, a line at a time, extending the selection -- the way every
   * terminal's own selection does. */
  private selectionScroll?: { timer: NodeJS.Timeout; direction: 1 | -1; col: number };
  /** Rows dropped from the front of alternateTranscript, so a line's number
   * stays the same when older rows are trimmed. */
  private alternateTrimmed = 0;
  /** Each message's first line in the transcript, numbered as
   * alternateTrimmed + index, so it holds while rows are trimmed. */
  private readonly messageLines = new Map<number, number>();
  /** /search: the mention being looked at in the conversation shown, its
   * words highlighted; `jumped` once the view has been moved to it. */
  private mentionFocus?: MentionFocus & { sessionId: string; jumped: boolean };
  /** The live rows below the transcript in the last frame: the text a
   * selection copies from them. */
  private frameLayout = { live: [] as string[] };
  /** What the composer's slash palette offers, remembered from the last
   * question() so a turn in flight can offer the same commands. A turn does
   * not change which commands exist; each is re-checked when it runs. */
  private paletteCommands: readonly PaletteEntry[] = [];
  /** The prompt this client submitted, held from Enter until the turn ends.
   * See render/pending-prompt.ts: the snapshot alone cannot draw it for the
   * whole turn, so the client keeps its own copy of what it sent. */
  private submittedPrompt?: string;
  private pendingApproval?: ApprovalRequest & { shownAt: number; needsFocus: boolean; focused: boolean };
  private approvalGuardTimer?: NodeJS.Timeout;
  /** A short-lived hint (the Ctrl+C exit warning) that takes the notice row. */
  private transientNotice?: string;
  private transientNoticeTimer?: NodeJS.Timeout;
  private turnUsage?: TurnUsage;
  private thought?: Thought;
  private panelState?: { title: string; lines: string[]; offset: number; page: number; total: number };
  private planEntries: readonly PlanEntry[] = [];
  private streamingBlocks = createStreamingBlockParser();
  /** Re-installs the key listener and raw mode after Ctrl+Z / `fg`. */
  private resumeInput?: () => void;
  /** Providers fan out parallel tool calls, so a second request can arrive
   * while the first is still on screen. Queueing asks them one at a time;
   * resolving the extras false meant silently denying a tool the user was
   * never shown. */
  private approvalQueue: ApprovalRequest[] = [];
  /** Approvals answered since the last time none was waiting: this one is
   * number answered + 1 of answered + 1 + queued. */
  private approvalsAnswered = 0;
  /** Whether the terminal says it is being looked at (terminal-signals.ts). */
  private focus: FocusState = { since: 0 };
  private stopFocusReports?: () => void;
  /** The window title last written, so an unchanged one is not written. */
  private terminalTitle?: string;
  /** Long pastes held as placeholders so far, for the next one's number. */
  private pasteCount = 0;
  /** The line a turn ended on, owed to the transcript once. */
  private pendingTurnSummary?: string;
  /** "Tell it instead" is being typed; the draft the composer held before. */
  private tellingInstead?: { draft: string; cursor: number };
  private approvalRestoreLabel?: string;
  private readonly onWaitingKey = (key: string): void => {
    const turn = this.turn;
    if (!turn) return;
    // The terminal can lose cells during a mobile resize or a remote redraw.
    // Rebuild the whole viewport from our retained state, including the live
    // answer and any approval, without changing the turn or the draft.
    if (key === '\u000c') {
      this.requestRedraw('repair');
      this.forgetScreenPosition();
      this.paintWaiting(turn);
      return;
    }
    // Before approvals and before the draft: a turn running is when someone
    // wants to read what went past.
    if (!this.pendingApproval && this.handleScrollKey(key)) return;
    // Escape backs out one level, as it does everywhere else, and never
    // stops the turn. Scrolled back mid-turn it returns to the live edge; at
    // the edge it takes the newest waiting message back to edit.
    //
    // It used to stop the turn. A message sent and then Esc'd to fix a typo
    // stopped everything the turn was running -- its sub-agents with it --
    // when all that was wanted was the words back. Ctrl+C stops.
    if (!this.pendingApproval && key === '\u001b' && this.scrolledBack) {
      this.scrollTranscript(-Number.MAX_SAFE_INTEGER);
      return;
    }
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      // "No, and tell it what to do instead": the composer is where it is
      // typed, on its own -- whatever draft was there waits aside -- and
      // Enter denies the call and sends the text into the turn as a steer.
      const telling = this.tellingInstead;
      if (telling) {
        if (key === '\r') {
          const text = turn.draft.trim();
          if (!text) return;
          this.answerApproval(pending, false);
          // After the denial is on its way: the answer's own send is queued
          // behind this resolve, and the steer must not overtake it.
          setImmediate(() => this.submitWaiting(text, false));
          return;
        }
        if (key === '\u001b' || key === '\u0003') {
          this.restoreTellingDraft();
          if (key === '\u0003') this.answerApproval(pending, false);
          else this.updateWaiting();
          return;
        }
        const edited = editWaitingComposer(turn.draft, turn.cursor, key);
        if (edited.changed) {
          turn.draft = edited.value;
          turn.cursor = edited.cursor;
          this.updateWaiting();
        }
        return;
      }
      // Otherwise the draft is never edited from here: every key is either an
      // answer or dropped, so the composer is exactly as the user left it.
      const action = approvalKeyAction(key, Date.now() - pending.shownAt, pending.needsFocus, pending.focused, Boolean(pending.rule), Boolean(turn.submit));
      if (action === 'focus') {
        pending.focused = true;
        this.updateWaiting();
      } else if (action === 'tell') {
        this.tellingInstead = { draft: turn.draft, cursor: turn.cursor };
        turn.draft = '';
        turn.cursor = 0;
        this.updateWaiting();
      } else if (action === 'allow' || action === 'always' || action === 'deny') {
        this.answerApproval(pending, action === 'deny' ? false : action === 'always' ? 'always' : true);
      }
      return;
    }
    // Up and Down with nothing typed read the conversation, as they do at
    // the prompt. A phone sends a swipe as arrow keys and nothing else once
    // its keyboard is up, so without this a running turn was the one time
    // the conversation could not be scrolled at all -- recorded: a long turn,
    // the keyboard came up, and every swipe after that did nothing.
    if ((key === '\u001b[A' || key === '\u001b[B') && !turn.draft) {
      if (this.scrollTranscript(key === '\u001b[A' ? SWIPE_ROWS : -SWIPE_ROWS)) return;
      if (key === '\u001b[B') this.noteReadingDirection();
      return;
    }
    // Left with nothing typed steps away from the turn -- to the conversation
    // board -- and leaves it running: the worker owns it, not this window.
    if (key === '\u001b[D' && !turn.draft && turn.leave) {
      turn.leave();
      return;
    }
    const action = waitingInputAction(key);
    if (action === 'take-back') {
      this.takeBackWaiting();
    } else if (action === 'stop') {
      if (turn.cancelled) return;
      turn.cancelled = true;
      turn.label = 'stopping…';
      this.updateWaiting();
      // A turn that did nothing yet gives its prompt back to edit -- unless
      // something is already typed, which keeps the composer.
      const restoreDraft = !turn.draft.trim();
      if (turn.early) turn.early.interrupt = { restoreDraft };
      turn.cancel?.(restoreDraft);
    } else if (key === '\u001a') {
      this.suspendToShell();
    } else if (key === '\r' && this.signInInput) {
      const text = turn.draft.trim();
      if (!text) return;
      turn.draft = '';
      turn.cursor = 0;
      this.signInInput.submit(text);
      this.updateWaiting();
    } else if (this.signingIn && !turn.submit && (key === '\r' || this.typedAhead.length)) {
      // Sent under a sign-in: the message stays in the composer, on screen,
      // and only its Enter waits -- for the turn or prompt that comes next,
      // which the draft is handed on to.
      if (key === '\r' && !this.typedAhead.length && !turn.draft.trim()) return;
      this.typedAhead.push(key);
    } else if (key === '\r') {
      const continued = turn.submit ? backslashNewline(turn.draft, turn.cursor) : undefined;
      if (continued) {
        turn.draft = continued.value;
        turn.cursor = continued.cursor;
        this.updateWaiting();
        return;
      }
      if (!turn.submit) return;
      // Enter again, nothing typed, on a message already waiting: stop the
      // turn -- its tool calls and sub-agents with it -- and what waits is
      // sent as the next turn at once (the loop takes the queue's head).
      const enter = waitingEnterAction(turn.draft, this.messageWaiting(), Boolean(turn.cancel) && !turn.cancelled);
      if (enter === 'stop-and-send') {
        turn.cancelled = true;
        turn.label = 'stopping…';
        this.updateWaiting();
        turn.cancel!(false);
        return;
      }
      if (enter !== 'deliver') return;
      const text = turn.draft.trim();
      turn.draft = '';
      turn.cursor = 0;
      this.submitWaiting(text);
    } else if (turn.submit || turn.early || this.signInInput || this.signingIn) {
      // A sign-in's wait keeps what is typed under it too: the composer that
      // opens after it starts with that text (stopWaiting hands it on), where
      // dropping it lost the start of a message typed as a sign-in finished.
      const edited = editWaitingComposer(turn.draft, turn.cursor, key);
      if (edited.changed) {
        turn.draft = edited.value;
        turn.cursor = edited.cursor;
        this.updateWaiting();
      }
    }
  };

  /** `/send steer|queue`, from the setting (the loop) or the command. */
  setSendMode(mode: SendMode): void {
    if (mode === this.sendMode) return;
    this.sendMode = mode;
    if (this.turn) this.updateWaiting();
  }

  /** A message typed during this turn is waiting with its row on screen --
   * queued for after it, or held for its next pause -- so Enter on nothing
   * means "send it now". One still being submitted has not been answered yet:
   * a quick double Enter must not stop the turn it was meant to reach. */
  private messageWaiting(): boolean {
    return Boolean(this.currentSession?.queuedTurns?.some((item) => item.kind !== 'command'))
      || this.waitingSubmissions.some((item) => item.state === 'queued');
  }

  /** Esc mid-turn: the newest message still waiting -- queued, or held for
   * the turn's next pause -- comes back into the composer, ahead of anything
   * typed, and is gone from the queue. Nothing running is touched. One
   * already on its way into the turn stays where it is. */
  private takeBackWaiting(): void {
    const turn = this.turn;
    if (!turn?.takeBack) return;
    const stored = (this.currentSession?.queuedTurns ?? []).filter((item) => item.kind !== 'command');
    const last = [
      ...stored.map((item) => ({ id: item.id, text: item.text })),
      ...this.waitingSubmissions.filter((item) => item.state === 'queued' && item.id && !stored.some((entry) => entry.id === item.id))
        .map((item) => ({ id: item.id!, text: item.text })),
    ].at(-1);
    if (!last) return;
    void turn.takeBack(last.id).then((outcome) => {
      if (outcome !== 'removed') return;
      this.waitingSubmissions = this.waitingSubmissions.filter((item) => item.id !== last.id);
      if (this.currentSession?.queuedTurns) this.currentSession.queuedTurns = this.currentSession.queuedTurns.filter((item) => item.id !== last.id);
      if (this.turn) {
        this.turn.draft = this.turn.draft ? `${last.text}\n${this.turn.draft}` : last.text;
        this.turn.cursor = last.text.length;
        this.updateWaiting();
      } else this.queuedDraft = this.queuedDraft ? `${last.text}\n${this.queuedDraft}` : last.text;
    }, () => undefined);
  }

  /** A message typed during the turn, sent: steered into it or queued
   * behind it (the harness decides; its row says which), or a slash line,
   * which is ClikCode's own command. */
  private submitWaiting(text: string, allowCommand = true): void {
    const turn = this.turn;
    if (!turn?.submit) {
      this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${text}` : text;
      return;
    }
    // A slash line is ClikCode's own command and never text for the model.
    // Handed to the caller to route (see waiting-slash.ts and slash/queue.ts);
    // a line the router decides is really conversation comes back 'queued'.
    const asCommand = allowCommand && Boolean(commandLineTypedDuringTurn(text)) && Boolean(turn.command);
    const submit = asCommand ? turn.command! : turn.submit;
    // No selection mid-turn -- the arrows scroll the answer -- so a partly
    // typed value means the best match: `/model op` applies opus.
    const line = asCommand ? completedCommandLine(text, this.paletteCommands) : text;
    const localId = ++this.waitingSubmissionId;
    // A message gets a row, because the user needs to know where their words
    // went. A command gets none: it either applies (and the status line it
    // changed already shows that) or it runs at the turn boundary. A row
    // saying so would be the announcement this is meant not to make.
    if (!asCommand) {
      this.waitingSubmissions.push({
        localId, text, responseOffset: this.liveResponse.length, sequence: ++this.timelineSequence, state: 'sending',
      });
    }
    this.updateWaiting();
    const write = submit(line).then((result) => {
      const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
      if (item) {
        item.state = result.disposition;
        item.id = result.submission.id;
        if (result.unsteered) item.unsteered = true;
      }
      this.updateWaiting();
    }).catch(() => {
      const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
      if (item) item.state = 'error';
      if (this.turn && !this.turn.draft) {
        this.turn.draft = text;
        this.turn.cursor = text.length;
      }
      this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${text}` : text;
      this.updateWaiting();
    });
    this.waitingSubmissionWrites.add(write);
    void write.finally(() => this.waitingSubmissionWrites.delete(write));
  }

  /** An approval answered: the next one waiting comes up, or the band goes
   * back to what the turn was doing. */
  private answerApproval(pending: NonNullable<TerminalHarnessPrompter['pendingApproval']>, answer: boolean | 'always'): void {
    lifecycle('window.approval.answer', { answer: answer === 'always' ? 'always' : answer ? 'allow' : 'deny' });
    this.pendingApproval = undefined;
    this.approvalsAnswered += 1;
    pending.resolve(answer);
    if (!this.presentNextApproval()) {
      if (this.turn) this.turn.label = this.approvalRestoreLabel || 'thinking';
      this.approvalRestoreLabel = undefined;
      this.resumeClock();
      this.updateWaiting();
    }
  }

  /** The draft set aside for "tell it instead", back in the composer. */
  private restoreTellingDraft(): void {
    const telling = this.tellingInstead;
    if (!telling) return;
    this.tellingInstead = undefined;
    if (this.turn) {
      this.turn.draft = telling.draft;
      this.turn.cursor = telling.cursor;
    }
  }
  private readonly onResize = (): void => {
    if (!this.closed) {
      // The settled repaint redraws everything at the new size, and a change
      // of width wraps the transcript again from its source first.
      this.forgetScreenPosition();
      logCursorEvent(`resize screen=${output.columns}x${output.rows} raw=${terminalModes.rawMode} alternate=${terminalModes.alternateScreen}`);
      // A phone sends several size changes while its keyboard moves: one
      // settled repaint carries the phone's resize sequence (redrawPreamble)
      // inside its frame. Written here, the modes went out interleaved with
      // frames in flight, once per intermediate size.
      const first = !this.resizePaintTimer;
      this.requestRedraw('resize');
      // The first size of a burst is drawn at once, rows only: waiting out
      // the settle left the old layout on a resized screen for 120ms. The
      // phone's sequence still goes out once, with the settled frame.
      if (first && !this.suspended) {
        this.provisionalFrame = true;
        try {
          this.rewrapIfWidthChanged();
          this.repaint();
        } finally {
          this.provisionalFrame = false;
        }
      }
      // No height probe here: it jumps the cursor to the bottom-right corner
      // and asks, at exactly the moment a swipe is being recognised. The size
      // the terminal announces is what the layout uses.
      this.repaintAfterResize();
    }
  };

  /** Never taller than the screen actually is: a live region that overflows
   * makes the walk back up to the composer clamp at the top edge, which is
   * what parks the cursor on the status line and strands rows below it. The
   * announced size is the ceiling -- a terminal that answers with more rows
   * than it announced is not offering rows we may use. */
  private viewportRows(): number {
    return Math.max(5, output.rows || 30);
  }

  /** The repaint a resize needs, once the resize is over.
   *
   * A keyboard sliding away is not one SIGWINCH, it is a burst of them -- the
   * session log has 70x55, 70x63, 70x40, 70x32 inside four hundred
   * milliseconds -- and painting per signal sent a full-screen repaint for
   * each. At 63 rows of styled transcript that is 4KB a piece, several of them
   * inside the moment the client is dismissing its keyboard and rebuilding the
   * view it decides gestures against.
   *
   * That collision is measured, not guessed. In one session, seven swipes with
   * the keyboard hidden delivered nothing at all; the eighth, with a
   * diagnostic that made every write slower, delivered wheel reports normally.
   * The same swipe works through a recording pty (which delays writes) and in
   * a bare script whose repaint is a tenth the size. Everything that slows or
   * shrinks this write makes the gesture arrive.
   *
   * So the burst is coalesced into the one repaint it always meant, drawn once
   * the size has stopped changing. Short enough not to be seen, long enough to
   * land after the client has finished. */
  private resizePaintTimer?: NodeJS.Timeout;
  /** The frame being drawn is a resize's immediate one: it leaves the
   * pending resize preamble to the settled frame. */
  private provisionalFrame = false;
  private repaintAfterResize(): void {
    if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
    this.resizePaintTimer = setTimeout(() => {
      this.resizePaintTimer = undefined;
      lifecycle('window.resize', { cols: output.columns, rows: output.rows });
      if (this.closed || this.suspended) return;
      this.rewrapIfWidthChanged();
      // Whole, whatever the immediate frame already drew: the preamble this
      // frame carries clears the screen.
      this.forgetScreenPosition();
      this.repaint();
    }, RESIZE_SETTLE_MS);
    this.resizePaintTimer.unref();
  }

  /** A row retired at one width is wrong at any other. Narrower, it is wider
   * than the screen: it wraps (or, with autowrap off, loses its tail) and
   * every row below it lands one out. So the transcript is not re-clipped
   * row by row but written again from its source -- the session's messages
   * and this turn's state -- exactly as opening the conversation writes it. */
  private rewrapIfWidthChanged(): void {
    const columns = output.columns || 0;
    if (columns === this.transcriptColumns) return;
    this.transcriptColumns = columns;
    this.emitted.requestReseed();
  }

  /** Empty the transcript before the conversation is written again. What is
   * above the live region is only ever the conversation being shown: another
   * one, or this one at an old width, is dropped -- not pushed up behind a
   * screenful of blank rows, where scrolling up found it. */
  private clearTranscript(): void {
    // Line numbers stay unique across the rewrite, so nothing that holds one
    // can land on a row it did not mean.
    this.alternateTrimmed += this.alternateTranscript.length;
    this.alternateTranscript.length = 0;
    this.pendingFinished = [];
    this.lastFinishedRow = undefined;
    this.secondLastFinishedRow = undefined;
    this.alternateScrollback = 0;
    this.messageLines.clear();
    this.stopSelectionScroll();
    this.selection = undefined;
  }

  /** Rows retired out of the viewport, kept so the conversation above the
   * live region is still there to scroll back to on the alternate screen. */
  private readonly alternateTranscript: string[] = [];
  /** Exactly the rows the last alternate-screen frame left on screen, so the
   * next one writes only what differs. */
  private alternatePrevious: string[] = [];
  /** How many rows above the live region the viewport is held back by. Zero
   * follows the conversation, which is what a transcript does until someone
   * asks to look at what went past. Drawing on the alternate screen took the
   * terminal's own scrollback away; this is what replaces it. */
  private alternateScrollback = 0;
  /** Rows the last frame gave the transcript above the live region. The
   * scroll offset is bounded by it, and it changes with the screen. */
  private alternateAbove = 0;
  /** Whether the last frame left the cursor shown (undefined: not known), and
   * where it parked it, so a frame that changes neither writes nothing. */
  private cursorShown: boolean | undefined;
  private lastPark = '';

  /** The alternate screen is not optional: construction is gated on
   * terminalUiSupported(), which requires a TTY, and a non-TTY caller fails
   * here rather than entering a half-working mode. */
  constructor() {
    if (!output.isTTY) {
      throw new Error('TerminalHarnessPrompter requires a TTY on stdout; construct it behind terminalUiSupported()');
    }
    const inheritedScreen = process.env[REEXEC_TERMINAL_ENV] === '1';
    delete process.env[REEXEC_TERMINAL_ENV];
    terminalModes.uiStarted = true;
    // Stdin is kept flowing for the whole session.
    //
    // Every reader attaches its own `data` listener and removes it again --
    // seven attach/detach cycles a session -- and removing the LAST one puts
    // the stream back into paused mode. So between a prompt ending and the
    // next one opening, stdin was stopped, and anything the client sent in
    // that window sat in the pty buffer instead of being read. The diagnostic
    // UI which does receive the keyboard-hidden swipe on this user's phone
    // never stops reading, and neither does Claude Code.
    //
    // A listener that does nothing is enough: its presence is what keeps the
    // stream flowing. The readers still come and go and still do the work.
    input.on('data', KEEP_STDIN_FLOWING);
    input.resume();
    // Undo whatever the last program left set, before asking for anything.
    // The session before this one may have been closed from the client, in
    // which case its teardown was written into a pty that no longer existed.
    output.write(terminalPrepare());
    {
      // Every mode in one breath, with the screen, in this order -- copied
      // from the bare script that receives the gesture on this user's phone
      // when this program does not. Measured minutes apart in the same
      // failing state: that script took 64,214 wheel reports with the
      // keyboard hidden and ClikCode took none, and the opening was the only
      // thing left that differed. It asked for all seven the moment it took
      // the screen; this asked for the four mouse modes and left paste, theme
      // and focus until the first prompt opened, several frames later.
      //
      // The `?1006l` before `?1006h` is the script's, kept deliberately: it
      // makes SGR reporting a transition rather than a no-op, and a client
      // deciding how to route touches has something to notice.
      logProcessWarnings();
      if (!inheritedScreen) output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
      // Asked for: bracketed paste, because pasted text must not be read as
      // keystrokes; the mouse, because that is how the transcript is read
      // back; and focus reports, because a turn that ends or an approval
      // that waits while the user has looked away is worth a notification
      // (see notifyIfAway). Not theme notifications: nothing acts on them,
      // and the filter that drops them stays for a terminal that sends them
      // unasked.
      //
      // Selection mode means the user asked for the mouse back; taking the
      // screen must not quietly take it again.
      output.write(sessionModesOn(true));
    }
    // The shell's own title is saved, to be put back on the way out; this
    // UI sets its own while it runs (syncTerminalSignals).
    if (inheritedScreen) terminalModes.titlePushed = true;
    else this.takeTerminalTitle();
    this.stopFocusReports = onTerminalFocus((focused) => { this.focus = { focused, since: Date.now() }; });
    output.write('\u001b[?25h');
    process.on('SIGWINCH', this.onResize);
    // Any exit path -- process.exit() deep in a command, an uncaught error, a
    // signal handler elsewhere -- must not leave the shell in raw mode with a
    // hidden cursor and bracketed paste on.
    process.on('exit', restoreTerminal);
    installTerminalRestoreSignals();
  }

  /** What this client just sent, from the moment Enter was pressed until the
   * turn ends. The turn's own journal (`session.pendingTurn`) is the other
   * source and arrives later; see render/pending-prompt.ts. */
  submitted(prompt: string | undefined): void {
    this.submittedPrompt = prompt;
  }

  /** The conversation as the transcript writes it outside a turn's own view.
   *
   * A journal nothing runs is an interrupted turn, folded in as one (its
   * prompt, then its text and calls). A journal a
   * worker is still running is NOT: the live view owns that turn. Folded, it
   * went into scrollback -- which cannot be taken back -- above the same turn
   * drawn live, a second copy for every trip to the board and back; and its
   * summary text, which grows with each call, then hid the seam, so the real
   * answer was never written at all. Decided here, for every paint, from what
   * the render said: unsaid means it may be running, so no caller that does
   * not know can fold it. */
  private transcriptMessages(session: HarnessSession): NonNullable<HarnessSession['messages']> {
    return this.journal.running ? settledTranscriptMessages(session, this.journal.prompt) : sessionTranscriptMessages(session);
  }

  /** Where activity outside a turn goes: after the conversation as drawn --
   * a prompt held for a turn not started yet (a sign-in before it) included,
   * or its outcome line lands at a place already written and is never drawn. */
  private restingAnchor(): number {
    const session = this.currentSession;
    if (!session) return 0;
    const stable = session.messages ?? [];
    const held = pendingPromptText({ ...(this.submittedPrompt ? { sticky: this.submittedPrompt } : {}), lastMessage: stable[stable.length - 1] });
    return held ? stable.length + 1 : this.transcriptMessages(session).length;
  }

  render(session: HarnessSession, _account?: string, notice?: string, journal?: JournalState): void {
    if (this.currentSession?.id !== session.id) {
      setLifecycleSession(session.id);
      lifecycle('window.conversation', { from: this.currentSession?.id ?? null, harness: session.nativeHarness ?? session.route });
      // A /search mention belongs to the conversation it was found in.
      if (this.mentionFocus?.sessionId !== session.id) this.mentionFocus = undefined;
      this.activityEntries = [];
      this.planEntries = [];
      this.panelState = undefined;
      // The conversation opened is the only one in the transcript.
      this.emitted.requestReseed();
      // Rewritten whole, a turn still running included, once it is followed.
      this.steppedOut = undefined;
    }
    this.journal = journal ?? { running: true };
    // The turn stepped out of is over -- ended, with its record saved, or
    // interrupted. What it streamed is matched against that like any end.
    if (this.steppedOut && (!this.journal.running || (session.messages?.length ?? 0) > this.steppedOut.anchor)) {
      this.steppedOut = undefined;
    }
    // A snapshot that already holds this turn's durable record -- folded into
    // `messages`, its journal gone -- IS the end of the turn for the screen,
    // whichever order it and "stopped waiting" arrive in. The worker sends the
    // final snapshot first; the in-process path stops first. Ending it here,
    // before anything is drawn, is what makes that order irrelevant: the live
    // answer is retired once, into the place the saved one is then matched
    // against. Drawing the snapshot while still waiting put the answer on
    // screen twice (saved and live); dropping the live copy without retiring
    // it made the last block vanish. Both were seen, in that order, across
    // two fixes that each chose one arrival order. See scripts/tui-e2e.
    // Only a snapshot that says the turn is over: one taken while it still
    // runs (a worker's carries `live`) never ends it, whatever its record
    // holds.
    if (this.turn && !this.journal.running && this.currentSession?.id === session.id && !session.pendingTurn
      && (session.messages?.length ?? 0) > this.activityAnchor) {
      this.stopWaiting(false, 'saved');
    }
    if (!this.turn) this.waitingSubmissions = [];
    this.currentSession = session;
    this.currentNotice = notice;
    // A render receives authoritative persisted state. Drop the transient
    // stream so the just-saved assistant message is never painted twice --
    // but NOT while a turn is running, where the live answer is the one thing
    // that is not persisted yet. A setting applied mid-turn renders the status
    // line (see harness/output.ts), and clearing here would take the
    // half-written answer off the screen with it. Nor while stepped out of a
    // turn: that answer is carried on from when the turn is followed again.
    if (!this.turn && !this.steppedOut) {
      if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
      this.responsePaintTimer = undefined;
      this.liveResponse = '';
    }
    // A picker owns the screen while it is open. A setting flipped from inside
    // one renders the status line (harness/output.ts), and painting the
    // composer here would draw it over the list being used; the state is kept
    // and the frame repaints with it when the picker closes.
    if (this.selecting) return;
    // A running turn's composer is its draft, not empty.
    this.paint(this.turn?.draft ?? '', [], 0, '› ', this.turn?.cursor ?? 0);
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    // An empty replacement is meaningful when a failed streaming attempt is
    // about to retry on another account. Appends with no content remain a
    // no-op, but replace must clear the obsolete partial response.
    if (!text && mode === 'append') return;
    // The thought led to this text; once the answer is arriving it is stale.
    if (text) { this.thought = undefined; if (this.turn) this.turn.thinkingSince = Date.now(); }
    // A replacement is usually the same answer again, so only its growth counts.
    this.streamedChars += mode === 'replace' ? Math.max(0, text.length - this.liveResponse.length) : text.length;
    if (mode === 'replace') {
      // Only a turn in flight has tool rows whose place in the answer can
      // move. After it, a replacement (a snapshot's copy of the finished
      // answer) would rebase them against an empty stream -- to offset zero,
      // above the prose they followed.
      if (this.turn) this.activityEntries = rebaseActivityOffsets(this.activityEntries, this.activityAnchor, this.liveResponse, text);
      this.liveResponse = text;
    } else this.liveResponse += text;
    this.schedulePaint();
  }

  activity(message: string): void {
    const normalized = sanitizeTerminalText(message, { keepSgr: true, singleLine: true }).trim();
    const last = this.activityEntries[this.activityEntries.length - 1];
    if (!normalized || last?.lines[last.lines.length - 1] === normalized) return;
    this.activityEntries = [...this.activityEntries, {
      anchor: this.turn ? this.activityAnchor : this.restingAnchor(),
      ...(this.turn ? { responseOffset: this.liveResponse.length } : {}),
      // Every entry gets one, waiting or not: it is this row's identity for
      // "already retired", and two rows that happen to say the same thing are
      // still two rows.
      sequence: ++this.timelineSequence,
      lines: [normalized],
    }];
    this.schedulePaint();
  }

  /** Optional: the agent's current plan/todo list, shown as a compact block in
   * the live region. Pass an empty list to remove it. */
  setPlan(entries: readonly PlanEntry[]): void {
    this.planEntries = entries.map((entry) => ({ ...entry }));
    this.schedulePaint();
  }

  /** `live`: this is the running turn's activity number `index`, which
   * happened `responseOffset` characters into its answer -- a worker's
   * record of the turn, replayed whole whenever a window (re)joins it. One
   * already shown is skipped, so replaying is safe at any moment. */
  activityEvent(event: HarnessActivityEvent, live?: { index: number; responseOffset: number }): void {
    if (live) {
      if (live.index <= this.liveActivitiesShown) return;
      this.liveActivitiesShown = live.index;
    }
    if (event.parentId) {
      // A sub-agent's own calls stay inside the agent row. They are not
      // separate messages, and they do not move the status line.
      // What it is doing (a call) or saying (its prose, its thinking) now.
      if (event.kind === 'tool-start' || event.kind === 'thinking') this.childActivity.set(event.parentId, event.label);
      else if (event.kind === 'tool-done' || event.kind === 'tool-error') this.childActivity.delete(event.parentId);
      // And how much it has done, as Claude Code counts it: the agent row
      // ends "(12 tool uses, 1m 5s)".
      if (event.kind === 'tool-start') {
        this.activityEntries = this.activityEntries.map((entry) => {
          const parent = entry.event;
          if (!parent || parent.id !== event.parentId) return entry;
          const counted = withChildTool(parent, event);
          return { ...entry, event: counted, lines: renderActivityLine(counted).map((line) => line.trim()) };
        });
      }
      this.schedulePaint();
      return;
    }
    if (event.kind === 'thinking') {
      // Reasoning is one live row, never the transcript: the current item's
      // text as it accumulates (see appendThought). A bare "thinking" label
      // says nothing the spinner does not.
      const prior = this.thought;
      this.thought = appendThought(prior, sanitizeTerminalText(event.label, { singleLine: true }), event.id);
      if (this.thought && this.thought !== prior) {
        const extends_ = prior && prior.id === this.thought.id && this.thought.text.length > prior.text.length;
        this.streamedChars += extends_ ? this.thought.text.length - prior.text.length : this.thought.text.length;
      }
      this.schedulePaint();
      return;
    }
    if (event.kind === 'tool-start') this.thought = undefined;
    const anchor = this.turn ? this.activityAnchor : this.restingAnchor();
    const responseOffset = this.turn ? live?.responseOffset ?? this.liveResponse.length : undefined;
    this.activityEntries = upsertActivityEvent(this.activityEntries, anchor, responseOffset, event, ++this.timelineSequence);
    // The status line follows the work: "running tests", "editing app.ts"
    // while a call is open, the turn's own phase otherwise. The call itself
    // is also one row in the live transcript, below.
    const lifecycle = activityLifecyclePhase(this.activeTools, event);
    // The last open call finishing starts a new stretch of thinking.
    if (this.turn && this.activeTools.size && !lifecycle.activeTools.size) this.turn.thinkingSince = Date.now();
    this.activeTools = lifecycle.activeTools;
    this.schedulePaint();
  }

  /** A scrollable viewer in the live region. It used to keep only the last six
   * lines of the body, which cut /help and capability listings to their tail.
   * The whole body is kept; the prompt scrolls it (Up/Down/PgUp/PgDn while the
   * draft is empty) and q, Esc or Enter closes it. */
  panel(title: string, body: string): void {
    const lines = sanitizeTerminalText(body, { keepSgr: true }).split('\n').map((line) => line.trimEnd());
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    this.panelState = { title: sanitizeTerminalText(title, { keepSgr: true, singleLine: true }), lines, offset: 0, page: 1, total: lines.length };
    this.repaint({ keepPalette: false });
  }

  /** True when the key was a panel command. Only consulted on an empty draft,
   * so none of these keys is ever taken away from text being typed. */
  private panelKey(key: string): boolean {
    const panel = this.panelState;
    if (!panel) return false;
    const last = Math.max(0, panel.total - panel.page);
    const scrollTo = (offset: number): boolean => { panel.offset = Math.max(0, Math.min(last, offset)); return true; };
    if (key === '\u001b[A') return scrollTo(panel.offset - 1);
    if (key === '\u001b[B') return scrollTo(panel.offset + 1);
    if (key === '\u001b[5~') return scrollTo(panel.offset - Math.max(1, panel.page - 1));
    if (key === '\u001b[6~' || key === ' ') return scrollTo(panel.offset + Math.max(1, panel.page - 1));
    if (key === 'g') return scrollTo(0);
    if (key === 'G') return scrollTo(last);
    if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\r') { this.panelState = undefined; return true; }
    return false;
  }

  /** Progress on a wait already showing ("downloading… 42%"), without
   * restarting it the way startWaiting does. */
  updateWaitingLabel(message: string): void {
    if (!this.turn) return;
    this.turn.label = message;
    this.updateWaiting();
  }

  /** A turn this window joined mid-way: count from when it really started,
   * and say what it is running, instead of "thinking (0s)". */
  joinedWaiting(startedAt?: number, activity?: string): void {
    if (!this.turn) return;
    if (startedAt !== undefined) this.turn.clock = joinTurnClock(this.turn.clock, startedAt);
    if (activity) this.turn.label = activity;
    this.updateWaiting();
  }

  /** A vendor sign-in on screen (commands/account.ts withSignIn): its link
   * and code above the waiting band, a code or key typed into the waiting
   * composer, a choice in the picker, Esc cancelling it. Inside a running
   * turn (a sign-in the turn asked for) it borrows the turn's band and Esc
   * rather than starting a wait, which would reset the turn; stop() gives
   * them back. */
  signInScreen(name: string): SignInScreen {
    lifecycle('window.signin.start', { name });
    const controller = new AbortController();
    const label = `waiting for you to sign in to ${name} in your browser`;
    const cancel = (): void => controller.abort();
    const local = hasLocalDisplay();
    let opened = false;
    const show = (link: LoginLink): void => {
      if (local && !opened) { opened = true; openLoginUrl(link.url); }
      if (!local) output.write(loginUrlNotice(link.url).clipboard);
      this.signInLines = [
        `${chalk.bold(`Sign in to ${name}`)}${link.code ? ` · confirm the code ${chalk.bold(link.code)}` : ''}`,
        // Its own plain line: the band wraps a link rather than cutting it.
        link.url,
        chalk.dim(local ? 'opened in your browser' : 'link copied: open it on this device'),
      ];
      this.updateWaiting();
    };
    // A code or key typed under the link: the waiting composer takes it, and
    // the band says what it is for.
    // What was typed before the sign-in asked: set aside for the code, and
    // put back once it is answered (or the sign-in ends unanswered). The
    // code itself is the sign-in's and never joins it.
    let aside: { draft: string; cursor: number } | undefined;
    const putBack = (): void => {
      const live = this.turn;
      if (live && aside) { live.draft = aside.draft; live.cursor = aside.cursor; }
      aside = undefined;
    };
    const ask = (prompt: string, secret: boolean): Promise<string> => new Promise((resolve) => {
      const live = this.turn;
      if (live) {
        aside ??= { draft: live.draft, cursor: live.cursor };
        live.draft = ''; live.cursor = 0; live.label = `${prompt} · type it and press Enter`;
      }
      this.signInInput = {
        secret,
        submit: (text) => {
          this.signInInput = undefined;
          putBack();
          if (this.turn) this.turn.label = label;
          resolve(text);
        },
      };
      this.updateWaiting();
    });
    const turn = this.turn;
    const saved = turn ? { label: turn.label, cancel: turn.cancel, cancelled: turn.cancelled } : undefined;
    // A choice is the picker. Outside a turn the wait is this sign-in's own,
    // so it steps aside for the picker and comes back after.
    const choose = async (title: string, choices: readonly string[]): Promise<number | undefined> => {
      if (!turn) this.stopWaiting(false);
      try {
        return await this.select(title, choices.map((choice, index) => ({ label: choice, value: index })));
      } finally {
        if (!turn && !controller.signal.aborted) this.startWaiting(label, cancel);
      }
    };
    this.signingIn = true;
    if (turn) {
      turn.label = label;
      turn.cancel = cancel;
      turn.cancelled = false;
      this.scheduleWaitingTick();
      this.updateWaiting();
    } else this.startWaiting(label, cancel);
    return {
      signal: controller.signal, show, ask, choose,
      stop: () => {
        this.signInLines = [];
        // An unanswered code is dropped; what was typed for the conversation
        // stays in the composer -- the turn's, or (outside one) the prompt's
        // that opens next, by stopWaiting.
        if (this.signInInput && this.turn) { this.turn.draft = ''; this.turn.cursor = 0; }
        this.signInInput = undefined;
        putBack();
        this.signingIn = false;
        // Not repainted here: the outcome line withSignIn writes next paints,
        // and a paint between them drew the composer empty for a frame
        // while a message sent under the sign-in waited for its turn.
        // The message whose first use opened it is still on its way: its
        // prompt stays drawn into the turn that starts next.
        if (!turn) {
          this.signedInJustNow = true;
          const prompt = this.submittedPrompt;
          if (this.turn) this.stopWaiting(false);
          this.submittedPrompt = prompt;
          return;
        }
        if (this.turn !== turn) { this.schedulePaint(); return; }
        turn.label = saved!.label;
        turn.cancel = saved!.cancel;
        turn.cancelled = saved!.cancelled;
        this.scheduleWaitingTick();
        this.updateWaiting();
      },
    };
  }

  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
    onCommand?: (text: string) => Promise<LiveTurnInputResult>,
    onLeave?: () => void,
    onTakeBack?: (id: string) => Promise<TakeBackOutcome>,
  ): void {
    lifecycle('window.turn.start', { label: message.slice(0, 80), steerable: Boolean(onSubmit) });
    // stopWaiting is also how a finished turn drops its prompt. Calling it
    // here, a moment after Enter painted that prompt, used to drop the prompt
    // with it -- the message flashed and was gone until a later snapshot
    // happened to bring it back. This call is only resetting the previous
    // turn's waiting state. The prompt belongs to the turn being started.
    const submittedPrompt = this.submittedPrompt;
    // The same turn, drawn early: it carries on, its clock and draft with it.
    const early = this.turn?.early ? { ...this.turn } : undefined;
    if (early) this.turn!.draft = '';
    // Typed under the sign-in that opened as this message was sent (a
    // provider's first use): it belongs to the turn starting now -- in its
    // composer, and sent once the turn can take messages if Enter was
    // pressed (typedAhead, replayed below). Handed to the composer after the
    // turn instead, it vanished until the turn ended.
    const underSignIn = !early && this.signedInJustNow ? this.queuedDraft : undefined;
    this.signedInJustNow = false;
    if (underSignIn !== undefined) this.queuedDraft = undefined;
    this.stopWaiting(false);
    this.submittedPrompt = submittedPrompt;
    // A summary its turn never got to write (it ended with no answer) is
    // not this turn's.
    this.pendingTurnSummary = undefined;
    // Following again the very turn this window stepped out of, with nothing
    // redrawn in between: what it wrote is in scrollback, so it carries on
    // from there rather than starting the turn's view over beneath it.
    const out = this.steppedOut;
    this.steppedOut = undefined;
    const rejoined = Boolean(out && this.currentSession?.id === out.sessionId && out.prompt === submittedPrompt
      && (this.currentSession?.messages?.length ?? 0) === out.anchor);
    // A new turn is the reader rejoining the conversation.
    this.alternateScrollback = 0;
    if (!rejoined) this.liveResponse = '';
    // The last turn's plan, finished or left unfinished, is not this one's.
    if (!rejoined) this.planEntries = [];
    // A running turn always renders as stable messages, its submitted user
    // prompt, then one live assistant slot. Keep that slot fixed for the
    // whole turn: deriving it from sessionTranscriptMessages made the anchor
    // grow after the first response delta, so later tools jumped below the
    // assistant reply and appeared to arrive from nowhere.
    // The caller paints the submitted user prompt before entering waiting
    // mode, so the live assistant occupies the next array index exactly.
    // Internal commands that do not display their synthetic prompt also append
    // the transient assistant at this same index.
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    const turn: WaitingTurn = {
      label: message, clock: early?.clock ?? startTurnClock(Date.now()), thinkingSince: early?.thinkingSince ?? Date.now(),
      draft: early?.draft ?? underSignIn ?? '', cursor: early?.cursor ?? underSignIn?.length ?? 0, cancelled: false,
      ...(onCancel ? { cancel: onCancel } : {}), ...(onSubmit ? { submit: onSubmit } : {}),
      ...(onCommand ? { command: onCommand } : {}), ...(onLeave ? { leave: onLeave } : {}),
      ...(onTakeBack ? { takeBack: onTakeBack } : {}),
    };
    this.turn = turn;
    this.waitingSubmissions = [];
    this.waitingFrame = 0;
    this.streamedChars = 0;
    this.usageCharsCounted = 0;
    this.turnUsage = undefined;
    this.thought = undefined;
    this.panelState = undefined;
    // Whatever the previous turn retired belongs to the terminal now. This one
    // starts owing everything it produces, and nothing from before it.
    if (!rejoined) {
      this.activeTools = new Map();
      this.childActivity.clear();
      this.exploreGrouping.reset();
      this.liveActivitiesShown = -1;
      this.turnTranscript.reset();
      this.emitted.liveAnswerSettled();
      this.emitted.turnSequenceFloor = this.timelineSequence;
      this.streamingBlocks = createStreamingBlockParser();
    }
    if (input.isTTY) {
      const listen = (): void => {
        turn.stopInput = takeTerminalKeys(this.onWaitingKey);
        output.write(enterInputModes());
      };
      listen();
      this.resumeInput = () => { turn.stopInput?.(); listen(); };
    }
    // With the draft it carried in (an early start's, or one typed under a
    // sign-in): painted empty, it vanished until the next keystroke or tick.
    this.paint(turn.draft, [], 0, '› ', turn.cursor);
    this.scheduleWaitingTick();
    const keys = onSubmit ? this.typedAhead.splice(0) : [];
    if (keys.length) setImmediate(() => { for (const key of keys) if (this.turn === turn) this.onWaitingKey(key); });
    const interrupt = early?.early?.interrupt;
    if (interrupt && onCancel) {
      turn.cancelled = true;
      turn.label = 'stopping…';
      onCancel(interrupt.restoreDraft);
      this.updateWaiting();
    }
  }

  /** A turn is on its way, but what runs it is not answering yet: the first
   * message of a conversation waits on its worker starting, most of 150ms of
   * a node process loading. The message and the spinner are drawn now;
   * startWaiting then takes over the same clock and draft, and an interrupt
   * pressed meanwhile. */
  turnStarting(): void {
    this.startWaiting('thinking');
    if (this.turn) this.turn.early = {};
  }

  /** What the status line says about the newest open call, if any is open. */
  private toolStatus(): { phase: string; category?: ToolCategory } | undefined {
    return this.activeTools.size ? openToolsStatus(this.activeTools) : undefined;
  }

  /** What the turn waits on besides the model, for the clock's decisions. */
  private turnWaits(): TurnWaits {
    return { toolsRunning: this.activeTools.size > 0, approval: Boolean(this.pendingApproval) || this.signingIn };
  }

  private scheduleWaitingTick(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = undefined;
    if (this.closed) return;
    const now = Date.now();
    // Reduced motion never animates: the band ticks for the clock alone.
    this.waitingTickFast = !this.reducedMotion && turnAnimating(this.turnWaits());
    const delay = nextTurnTickMs(turn.clock, now, this.waitingTickFast);
    turn.timer = setTimeout(() => {
      turn.timer = undefined;
      if (this.turn !== turn || this.closed) return;
      if (this.waitingTickFast) this.waitingFrame++;
      // A tick that changes only the clock costs that one row: the frame
      // writes only the rows that differ from the last.
      this.updateWaiting();
      this.scheduleWaitingTick();
    }, delay);
    turn.timer.unref();
  }

  /** An approval has been answered (or the turn ended under one). */
  private resumeClock(): void {
    const turn = this.turn;
    if (turn?.clock.pausedAt === undefined) return;
    turn.clock = resumeTurnClock(turn.clock, Date.now());
    if (turn.timer) this.scheduleWaitingTick();
  }

  /** What the next prompt's composer opens with: a message that never
   * reached its turn, a cancelled one the worker hands back, or a `/`. */
  restoreDraft(value: string): void { this.queuedDraft = value; }
  async flushWaitingSubmissions(): Promise<void> {
    await Promise.allSettled([...this.waitingSubmissionWrites]);
  }

  /** This window stops following the running turn (← to the board); its
   * worker carries on with it. Not the turn's end, so nothing of it is
   * settled: treated as one, the half-streamed answer went into scrollback
   * cut mid-word, and following the turn again drew it all a second time
   * beneath. See steppedOut. */
  leaveTurn(): void {
    if (this.turn && this.currentSession) {
      this.steppedOut = { sessionId: this.currentSession.id, ...(this.submittedPrompt !== undefined ? { prompt: this.submittedPrompt } : {}), anchor: this.activityAnchor };
    }
    this.stopWaiting();
  }

  /** The turn showing now drives it, if a follow does (see WaitingTurn.ended). */
  onWaitingEnded(ended: () => void): void {
    if (this.turn) this.turn.ended = ended;
  }

  stopWaiting(refresh = true, why?: string): void {
    const turn = this.turn;
    if (turn) lifecycle('window.turn.end', { cancelled: turn.cancelled, ...(why ? { why } : {}) });
    if (turn) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.timer = undefined;
      turn.stopInput?.();
      this.resumeInput = undefined;
    }
    // Settled while the turn is still the current one: a "tell it instead"
    // draft goes back into its composer, handed off below.
    this.settleApprovals();
    // A turn that did real work ends on a line saying how long it took and
    // what it changed (Codex). Only a real turn -- one that took messages,
    // not a wait on a download or a shell command -- and only its end:
    // stepping out of it is not.
    if (turn?.submit && !this.steppedOut) {
      this.pendingTurnSummary = this.endOfTurnSummary(turn);
      this.notifyIfAway(`${this.currentSession?.name || 'ClikCode'}: the turn has finished`);
    }
    this.turn = undefined;
    this.thought = undefined;
    // Anything typed during the turn and not submitted is still the user's
    // text. It lives in the turn's draft while the turn runs, and the composer
    // that opens afterwards reads queuedDraft -- so without this handoff a
    // message typed while the answer streamed was simply gone the moment the
    // turn finished. Appended rather than assigned: a queued submission may
    // already be waiting there, and neither should overwrite the other.
    if (turn?.draft.trim()) {
      this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${turn.draft}` : turn.draft;
    }
    // The turn is over: its prompt is a real message now, and holding the
    // client's copy any longer would draw it twice.
    this.submittedPrompt = undefined;
    if (refresh && !this.closed) this.repaint({ keepPalette: false });
    turn?.ended?.();
  }

  /** The screen back from whoever had it (the shell after Ctrl+Z, a vendor
   * login): the alternate screen, the transcript rewrapped if they resized
   * it -- a phone's keyboard does -- and the next frame drawn whole. */
  private retakeScreen(): void {
    this.suspended = false;
    if (!terminalModes.alternateScreen) {
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
    }
    this.rewrapIfWidthChanged();
    this.forgetScreenPosition();
    this.retakeTerminalSignals();
  }

  /** Back from a hand-over (a `!` command, a picker that left the screen,
   * Ctrl+Z): every session mode on again, the title taken, and the next
   * frame drawn as after a resize -- the screen may well have changed size,
   * and was certainly drawn on by something else. */
  private retakeTerminalSignals(): void {
    if (!output.isTTY) return;
    output.write(sessionModesOn());
    this.takeTerminalTitle();
    this.requestRedraw('resize');
  }

  /** A resize outranks a repair: it does all a repair does, and more. */
  private requestRedraw(redraw: Redraw): void {
    if (this.pendingRedraw !== 'resize') this.pendingRedraw = redraw;
  }

  /** Save the shell's title, once per taking of the terminal. */
  private takeTerminalTitle(): void {
    if (!output.isTTY || terminalModes.titlePushed) return;
    output.write(PUSH_TITLE);
    terminalModes.titlePushed = true;
    this.terminalTitle = undefined;
  }

  /** The window title and the tab's progress indicator, kept in step with
   * the turn: whether it is working or waiting for the user, and the
   * conversation's name. Only what changed, for the next frame to carry
   * (pendingSignals), and never off a TTY. The title holds still while a turn
   * runs -- the progress indicator is what moves -- so a spinner tick writes
   * nothing here. */
  private terminalSignals(): string {
    if (!output.isTTY || this.suspended || this.closed || !terminalModes.titlePushed) return '';
    const running = Boolean(this.turn);
    const title = windowTitle({
      running, asking: Boolean(this.pendingApproval),
      ...(this.currentSession?.name ? { name: this.currentSession.name } : {}),
    });
    let sequence = '';
    if (title !== this.terminalTitle) { sequence += titleSequence(title); this.terminalTitle = title; }
    if (running !== terminalModes.progress) { sequence += progressSequence(running); terminalModes.progress = running; }
    return sequence;
  }
  /** Title and progress sequences owed to the terminal, written inside the
   * next synchronized frame rather than on their own beside it. */
  private pendingSignals = '';

  /** Something needs the user -- a turn ended, an approval waits -- and the
   * terminal said it lost focus long enough ago: tell them (OSC 9 and a
   * bell). A terminal that never reports focus is never notified. */
  private notifyIfAway(message: string): void {
    if (!output.isTTY || this.suspended || this.closed || !shouldNotify(this.focus, Date.now())) return;
    output.write(notifySequence(message));
  }

  /** The end-of-turn line, or nothing for a turn that ran no tools and took
   * under END_SUMMARY_MS. */
  private endOfTurnSummary(turn: WaitingTurn): string | undefined {
    const ms = turnElapsedMs(turn.clock, Date.now());
    const calls = this.activityEntries.filter((entry) => entry.event && entry.anchor >= this.activityAnchor
      && (entry.sequence ?? 0) > this.emitted.turnSequenceFloor);
    if (!endsWithSummary(ms, calls.length)) return undefined;
    return turnSummary({ ms, diffs: calls.flatMap((entry) => (entry.event?.diff?.length ? [entry.event.diff] : [])) });
  }

  phase(message: string): void {
    const turn = this.turn;
    if (!turn || turn.cancelled || turn.label === message) return;
    // The band says "waiting for approval" while one is up; remember the phase
    // for when it is answered instead of replacing that.
    if (this.pendingApproval) { this.approvalRestoreLabel = message; return; }
    turn.label = message;
    this.updateWaiting();
  }

  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'> {
    lifecycle('window.approval.ask', { title: title.slice(0, 80) });
    return new Promise<boolean | 'always'>((resolveApproval) => {
      if (!this.pendingApproval) this.approvalRestoreLabel = this.turn?.label ?? '';
      this.approvalQueue.push({
        title, ...(detail === undefined ? {} : { detail }), ...(preview === undefined ? {} : { preview }),
        ...(rule === undefined ? {} : { rule }), resolve: resolveApproval,
      });
      if (!this.pendingApproval) this.presentNextApproval();
    });
  }

  /** Returns false when nothing was waiting, so the caller knows to restore
   * the turn's own label instead of leaving a stale prompt on screen. */
  private presentNextApproval(): boolean {
    this.restoreTellingDraft();
    const next = this.approvalQueue.shift();
    if (!next) { this.approvalsAnswered = 0; return false; }
    // Each approval gets its own guard window and its own focus requirement:
    // answering the first of two must not let the same keypress, or the next
    // character of a sentence, answer the second.
    this.pendingApproval = { ...next, shownAt: Date.now(), needsFocus: Boolean(this.turn?.draft), focused: false };
    if (this.turn) {
      this.turn.label = 'waiting for approval';
      // The clock stops while the turn waits on the user, not on the agent.
      this.turn.clock = pauseTurnClock(this.turn.clock, Date.now());
    }
    if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
    // Repaint when the guard lifts so the answer row visibly becomes live.
    this.approvalGuardTimer = setTimeout(() => { this.approvalGuardTimer = undefined; this.updateWaiting(); }, APPROVAL_GUARD_MS);
    this.approvalGuardTimer.unref();
    this.notifyIfAway(`Approval needed: ${next.title}`);
    this.updateWaiting();
    return true;
  }

  /** A turn can end while an approval is on screen. Denying outstanding asks
   * is what releases the provider's own awaiting handler; dropping them left
   * it waiting on a promise that could never settle. */
  private settleApprovals(): void {
    const outstanding = [this.pendingApproval, ...this.approvalQueue];
    if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
    this.approvalGuardTimer = undefined;
    this.pendingApproval = undefined;
    this.approvalQueue = [];
    this.approvalRestoreLabel = undefined;
    this.approvalsAnswered = 0;
    this.restoreTellingDraft();
    this.resumeClock();
    for (const item of outstanding) item?.resolve(false);
  }

  /** Optional: token counts for the turn in flight, shown beside the elapsed
   * time. Cleared by the next startWaiting(). */
  setTurnUsage(usage: TurnUsage): void {
    this.turnUsage = { ...this.turnUsage, ...usage };
    // The vendor's count covers everything streamed so far; only what streams
    // after it is estimated.
    if (usage.output !== undefined) this.usageCharsCounted = this.streamedChars;
    this.updateWaiting();
  }

  /** Esc on an empty composer, while a turn is parked for the quota reset:
   * the interactive loop's way to stop waiting (one press, then cleared). */
  idleEscape?: () => void;

  usage(label?: string, resetLabel?: string): void {
    if (this.usageLabel === label && this.usageResetLabel === resetLabel) return;
    this.usageLabel = label;
    this.usageResetLabel = resetLabel;
    this.schedulePaint();
  }

  private statusText(): string {
    const session = this.currentSession;
    if (!session) return '';
    const context = compactPath(session.workspace ?? process.cwd());
    const provider = sessionProviderLabel(session);
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    // What the harness reported running beats what it was asked to run: a
    // session with no explicit choice knows nothing until the vendor
    // answers, and a vendor that substituted a model said so on its own
    // stream. Never a synthetic label: there is no model named "automatic",
    // and none named "default" either -- that placeholder was just the same
    // lie under a quieter name. A session's model is resolved to something
    // the harness really publishes when the harness is chosen and when the
    // session opens (resolveNativeModel), so an empty one here means the
    // harness publishes nothing at all. Showing no model is honest; showing
    // a fabricated one is not.
    const rawModel = harness?.modelArgvPrefix ? session.reported?.model ?? session.model ?? undefined : undefined;
    // A Gateway conversation shows the model its user chose; none chosen, the
    // Gateway picks per step and the line names no model. ClikCode Local's
    // model is its engine's catalog entry, named by label.
    const model = session.route === 'clikcode-local' ? localModelLabel(session.model)
      : isGatewayService(session) ? session.model ?? undefined : nativeModelLabel(harness?.command, rawModel);
    const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
    // The title is not on this line: it sits on the rule under the composer,
    // so a long one never truncates the provider, model or directory.
    return [provider, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  /** What the turn is doing, how long it has taken and how much it has
   * written -- the style of a native CLI's own status row -- driven by what
   * actually arrives: the open call names the verb, the clock stops for an
   * approval, the token count is estimated from the stream until the vendor
   * reports its own. */
  private waitingLine(turn: WaitingTurn): string {
    const now = Date.now();
    const elapsed = formatElapsed(turnElapsedMs(turn.clock, now));
    const tokens = formatTurnUsage(this.turnUsage, estimatedTokens(this.streamedChars - this.usageCharsCounted));
    // What it says and how it looks, by the shared rules (turn-flow.ts):
    // waiting on the user, the open call, the reasoning's heading, the
    // thinking in words.
    const tool = this.toolStatus();
    const status = turnStatus({
      phase: turn.label,
      ...(!turn.cancelled && tool ? { toolPhase: tool.phase } : {}),
      ...(this.thought && !turn.cancelled ? { thought: this.thought.text } : {}),
      thinkingMs: now - turn.thinkingSince,
      asking: Boolean(this.pendingApproval),
    });
    // The send mode (/send) is what Enter does with text: steer (each row
    // then says whether the agent took it) or queue. With nothing typed and
    // a message waiting, Enter again stops the turn and sends it.
    const enterHint = turn.draft.trim() ? ` · enter to ${this.sendMode}`
      : turn.cancel && !turn.cancelled && this.messageWaiting() ? ` · ${STEER_WORDS.stopAndSend}`
        : ` · type and press Enter to ${this.sendMode}`;
    const label = `${status.label} (${elapsed}${tokens ? ` · ${tokens}` : ''})`
      + `${turn.cancel && !this.pendingApproval ? ` · ${keyHint('stop')}` : ''}`
      + `${turn.leave && !this.pendingApproval && !turn.draft ? ' · ← conversations' : ''}`
      + `${turn.submit && !this.pendingApproval ? enterHint : ''}`;
    // What the agent is doing is essential and stays at full contrast; only the
    // counters and key hints after it are dimmed.
    const split = status.label.length;
    // One spinner, one motion, for every harness and every tool, the label
    // shimmering with it; both hold still only while an approval waits.
    const glyph = waitingSpinnerGlyph(this.reducedMotion ? 0 : this.waitingFrame);
    const painted = paintStatus({
      glyph, label: label.slice(0, split), tone: status.tone,
      ...(status.tone === 'tool' && tool?.category ? { category: tool.category } : {}),
      frame: this.waitingFrame, shimmer: !this.reducedMotion && this.waitingTickFast && status.tone !== 'asking',
    });
    return `${painted.spinner}  ${painted.label}${chalk.dim(label.slice(split))}`;
  }

  private updateWaiting(): void {
    if (!this.turn || this.closed || this.selecting || this.paletteActive) return;
    this.schedulePaint();
  }

  /** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
   * all arrive in the same few milliseconds. One shared scheduler collapses
   * those signals into a single atomic frame instead of queueing competing
   * terminal writes that briefly expose half-updated cursor/footer state. */
  private schedulePaint(delay = PAINT_COALESCE_MS): void {
    if (this.responsePaintTimer || this.closed || this.suspended || this.selecting || this.paletteActive) return;
    this.responsePaintTimer = setTimeout(() => {
      this.responsePaintTimer = undefined;
      if (!this.closed && !this.selecting && !this.paletteActive) {
        if (this.turn) this.paintWaiting(this.turn);
        else this.repaint();
      }
    }, delay);
    this.responsePaintTimer.unref();
  }

  /** The waiting frame, with the slash palette when one is being typed.
   *
   * A hint list, not a picker: during a turn Up/Down scroll the transcript
   * (which is the point -- reading what went past is why they are bound
   * there), so there is no selection to move and Enter runs what was typed.
   * Without this a command was invisible AND unavailable while an answer
   * streamed; `/model` went to the model as the word "/model". */
  private paintWaiting(turn: WaitingTurn): void {
    if (this.signInInput) {
      this.paint(this.signInInput.secret ? '•'.repeat(turn.draft.length) : turn.draft, [], 0, '› ', turn.cursor);
      return;
    }
    const found = turn.command ? commandPaletteMatches(turn.draft, this.paletteCommands) : [];
    // Commands while nothing has been typed past the name; the argument's
    // own values once it has. A bare hint row is not worth the space mid-turn.
    const matches = !turn.draft.includes(' ') || found[0]?.completes ? found : [];
    if (!matches.length) {
      this.paint(turn.draft, [], 0, '› ', turn.cursor);
      return;
    }
    this.paint(turn.draft, matches, 0, '› ', turn.cursor, {
      capacity: Math.min(matches.length, 8) + 2,
      hint: `${keyHint('apply')} · ${keyHint('stop')}`,
    });
  }

  /** Repaint with the composer exactly as the last paint left it -- with its
   * palette, or (`keepPalette: false`) without, since paint() reads an absent
   * palette as "there is none".
   *
   *  - KEEP the palette for an incremental repaint of an edit still in
   *    progress -- a resize, a coalesced paint, a scroll, a reading-direction
   *    change. The user is mid-`/command`; taking their palette away as the
   *    terminal reflows would be the bug.
   *  - CLEAR it where the composer is being re-established fresh and a stale
   *    palette would be wrong: a panel opening (paint() draws a panel only
   *    when no palette is up, so they are mutually exclusive), a turn ending,
   *    and resume() after a vendor has had the TTY -- the composer it repaints
   *    is a new one. In all three the palette belongs to a command that has
   *    already run. */
  private repaint(options: { keepPalette: boolean } = { keepPalette: true }): void {
    const { text, options: listed, selected, prompt, cursor, palette } = this.composer;
    this.paint(text, listed, selected, prompt, cursor, options.keepPalette ? palette : undefined);
  }

  private paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: { capacity?: number; hint?: string; hideCursor?: boolean; headings?: boolean }): void {
    const session = this.currentSession;
    if (!session || this.suspended) return;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.composer = {
      text: composer, options, selected, prompt, cursor,
      ...(palette ? { palette: { capacity: palette.capacity, hint: palette.hint, hideCursor: palette.hideCursor } } : {}),
    };
    // The last column is never printed in. DEC autowrap is off (every frame
    // that draws re-sends `\u001b[?7l`), which makes filling it safe on a
    // terminal that honours that -- but several mobile SSH clients, and
    // anything that filters the mode out in between, wrap eagerly instead and
    // turn a full-width row into two. Every motion in a frame is relative, so
    // each such row put the walk back up to the composer one row out, which is
    // what parked the cursor on the status line below the composer instead of
    // in it. Costing one column is a far better trade than that.
    const width = Math.max(12, output.columns || 100);
    const rowWidth = width - 1;
    const inner = width - 4;
    // The conversation transcript gets its own, tighter margin: a bare
    // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
    // on top of its own 4-column reservation (6 total) -- next to a native
    // CLI's own output, which runs close to the full terminal width with
    // only a bullet-and-space margin, ClikCode's wider gutter read as
    // noticeably narrower and "bleaker" for no real reason; this doesn't
    // touch inner itself, so the notice/composer/meta lines below (which
    // share it) are unaffected.
    const conversationInner = rowWidth - 2;
    const stableMessages = session.messages ?? [];
    const pending = this.turn ? session.pendingTurn : undefined;
    const pendingPrompt = pendingPromptText({
      ...(pending?.prompt ? { durable: pending.prompt } : {}),
      ...(this.submittedPrompt ? { sticky: this.submittedPrompt } : {}),
      lastMessage: stableMessages[stableMessages.length - 1],
    });
    const persistedMessages = pendingPrompt
      ? [...stableMessages, { role: 'user' as const, content: pendingPrompt }]
      : this.transcriptMessages(session);
    // Tool events often arrive before the first prose token. They still belong
    // to the in-flight assistant message. Render an empty temporary assistant
    // anchor immediately; otherwise the tools remain invisible and then all
    // appear at once when the first sentence arrives.
    const settledMessage = pendingPrompt ? undefined : persistedMessages[persistedMessages.length - 1];
    // Nothing of a turn stepped out of is drawn until it is followed again.
    // While a turn runs, its tools are anchored where it began (activityAnchor)
    // -- the same anchor turnTools reads them by. Comparing against the
    // transcript's length missed them whenever the transcript already held
    // the prompt (a window attached to a worker): every tool stayed invisible
    // until the first word of the answer, then all appeared at once.
    const hasTransientAssistant = !this.steppedOut && (transientAssistantRequired(
      this.liveResponse, Boolean(this.turn), this.turn ? this.activityAnchor : persistedMessages.length, this.activityEntries,
      settledMessage?.role === 'assistant' ? settledMessage.content : undefined,
    ) || Boolean(pending?.steers?.length));
    const storedQueued = session.queuedTurns ?? [];
    // A queued message has two sources and they overlap. It is drawn live the
    // moment it is typed (waitingSubmissions), and the loop then writes it
    // into the session (queuedTurns) -- so between the write landing and the
    // turn consuming it, both hold the same message and it was drawn twice.
    // The stored copy wins, being the one that survives this process. Steers
    // are deduplicated against their durable copy the same way, just below.
    const storedQueuedTexts = new Set(storedQueued.map((item) => item.text));
    const storedQueuedIds = new Set(storedQueued.map((item) => item.id));
    // By identity once the worker has answered with one; by text only in the
    // moment before -- when a match can only be this same message, already
    // written. Matching by text alone showed "yes" sent twice as one row.
    const storedCopy = (item: { id?: string; text: string }): boolean => (item.id ? storedQueuedIds.has(item.id) : storedQueuedTexts.has(item.text));
    // Steering was asked for and nothing running could take it: the row
    // says so, by identity, on whichever copy is drawn.
    const unsteeredIds = new Set(this.waitingSubmissions.flatMap((item) => (item.unsteered && item.id ? [item.id] : [])));
    const queuedMessages: Array<{ role: 'user'; content: string; queueState: string; unsteered?: boolean }> = [
      // A queued COMMAND is not a message and gets no row: it runs when the
      // turn ends and shows whatever it shows then.
      ...storedQueued.filter((item) => item.kind !== 'command')
        // Held by the running turn to steer in once no tool call is open
        // (acp-client.ts): it is on its way into this turn, not the next.
        .map((item) => ({
          role: 'user' as const, content: item.text, ...(unsteeredIds.has(item.id) ? { unsteered: true } : {}),
          queueState: this.turn && item.heldForTurn && item.heldForTurn === pending?.startedAt ? 'pause' as const : 'queued' as const,
        })),
      ...this.waitingSubmissions.filter((item) => item.state !== 'steered' && !storedCopy(item)
        && !hasDurableSteer(item, pending?.steers ?? []))
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state, ...(item.unsteered ? { unsteered: true } : {}) })),
    ];
    // While a turn runs a waiting message can be sent at once -- Enter again,
    // with nothing typed -- by stopping the turn, which the hint says: it ends
    // sub-agents too. Not while something is typed: Enter then delivers that.
    const sendNowHint = this.turn?.cancel && this.turn.submit && !this.turn.cancelled && !this.turn.draft.trim() ? ` · ${STEER_WORDS.stopAndSend} · ${keyHint('takeBack')}` : '';
    // The final status row is written without a trailing newline, so using
    // the complete terminal height is safe and important: leaving one row
    // unpainted allowed an obsolete status line to remain visibly duplicated.
    const targetHeight = this.viewportRows();
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    // Keep generation at the response's live edge, directly above the
    // composer. It is a fixed status band, not transcript content, so a long
    // streamed answer cannot scroll it away. Optional bands share only the
    // rows left after one composer row and its three fixed footer rows.
    // Two rows: the generating line, and one blank above it so the text still
    // being written is not flush against the spinner. Counted here because
    // this number is the height budget -- reserve one row for a band that
    // draws two and the last line of the answer is pushed off the screen.
    //
    // This band STAYS while someone scrolls back to read. It is the answer to
    // "is it still working", and losing it mid-read leaves no sign a turn is
    // even running. What does not stay is the answer's text -- see
    // maxLiveConversation below. The distinction is the point: a spinner and
    // an elapsed clock in a fixed place are status, while a sentence being
    // rewritten under the eye is the thing that made reading impossible.
    const notice = this.mentionFocus?.status ?? this.transientNotice ?? this.currentNotice;
    const budget = frameRowBudget({
      targetHeight, waiting: Boolean(this.turn), notice: Boolean(notice), requestedPaletteCapacity,
    });
    const { waitingRows, noticeRows, paletteRows } = budget;
    const paletteCapacity = paletteRows;
    let optionalRows = budget.optionalRows;
    const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
    // The software keyboard can make a mobile SSH viewport dramatically
    // shorter between two keystrokes. Bound the composer by what remains in
    // this exact frame so it can never create a physical terminal scroll.
    const approval = this.pendingApproval;
    const approvalRows = approval && optionalRows - paletteRows >= 2
      ? approvalBlockRows(approval, width, Math.min(optionalRows - paletteRows, Math.max(6, Math.floor(targetHeight * 0.6))), {
        guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS,
        needsFocus: approval.needsFocus, focused: approval.focused,
        position: this.approvalsAnswered + 1, total: this.approvalsAnswered + 1 + this.approvalQueue.length,
        canTell: Boolean(this.turn?.submit), telling: Boolean(this.tellingInstead),
      })
      : [];
    let liveBandBudget = Math.max(0, optionalRows - paletteRows - approvalRows.length - 2);
    // The newest words of the reasoning: it is read as it is written.
    const thoughtRows = this.turn && this.thought && !approval && liveBandBudget > 0
      ? [`  ${chalk.dim(chalk.italic(`✻ ${visibleTail(this.thought.text, Math.max(1, inner - 2))}`))}`] : [];
    liveBandBudget -= thoughtRows.length;
    // A link sign-in's link is wrapped, never cut: on a phone it is read (and
    // its code typed) from here.
    const signInWrapped = this.turn ? this.signInLines.flatMap((line) => {
      // The link arrives as its own plain line (account.ts).
      const room = Math.max(8, inner - 2);
      if (!/^https?:\/\/\S+$/.test(line)) return [`  ${visibleSlice(line, room)}`];
      const rows: string[] = [];
      for (let at = 0; at < line.length; at += room) rows.push(`  ${chalk.underline(line.slice(at, at + room))}`);
      return rows;
    }) : [];
    const signInRows = signInWrapped.length <= liveBandBudget ? signInWrapped : signInWrapped.slice(0, Math.max(0, liveBandBudget));
    liveBandBudget -= signInRows.length;
    const planGlyph = this.turn && !this.reducedMotion ? waitingSpinnerGlyph(this.waitingFrame) : undefined;
    const planRows = paletteRows || this.selecting ? [] : planBlockRows(this.planEntries, width, liveBandBudget, planGlyph);
    liveBandBudget -= planRows.length;
    let panelRows: string[] = [];
    const panel = this.panelState;
    if (panel && !paletteRows && !approval && !this.selecting && liveBandBudget >= 3) {
      const shown = panelBandRows(panel, inner, liveBandBudget, targetHeight);
      Object.assign(panel, { page: shown.page, total: shown.total, offset: shown.offset });
      panelRows = shown.rows;
    }
    const maxComposerRows = Math.max(
      1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - approvalRows.length - thoughtRows.length - signInRows.length - planRows.length - panelRows.length,
    );
    const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
    // -------------------------------------------------------------------
    // The append-only transcript. A finished row is retired into it exactly
    // once and never rewritten in place (only a change of width writes the
    // whole of it again); the live region below it -- the block still
    // receiving tokens, queued turns and the footer -- is rebuilt each frame.
    // TurnTranscript decides what can no longer change, and that is the whole
    // decision.
    // -------------------------------------------------------------------
    const finished: string[] = [];
    const emit = (rows: readonly string[]): void => {
      for (const row of rows) {
        const last = finished.length ? finished[finished.length - 1] : this.lastFinishedRow;
        const before = finished.length > 1 ? finished[finished.length - 2]
          : finished.length ? this.lastFinishedRow : this.secondLastFinishedRow;
        // An empty row on each side of a message, so two of them separate a
        // message from the answer under it and from the message after it.
        // Never a third, and never a leading one at the top of a transcript.
        if (row === '' && (last === undefined || (last === '' && (before === '' || before === undefined)))) continue;
        finished.push(row);
      }
    };
    const userMarker = chalk.bold('›');
    // No marker in front of a tool row. The bullet was there to carry the
    // category colour, and it cost a glyph on every line of every call --
    // including each line of captured output, which made a transcript of
    // real work read as a column of dots. The label already says `Bash(...)`
    // and carries the colour itself; the spinner in the waiting band is
    // where the category still shows while a call runs.
    const activityRows = (lines: readonly string[], category?: ToolCategory): string[] => (lines.length
      ? ['', ...lines.map((line, index) => {
        const text = visibleSlice(line, Math.max(1, conversationInner - 2));
        return `  ${index === 0 && category ? TOOL_CATEGORY_STYLE[category].paint(text) : text}`;
      }), '']
      : []);
    const messageRows = (content: string, marker: string): readonly string[] => cachedMessageRows(content, marker, conversationInner);
    /** A user-side message: what the user wrote, or a notice ClikCode sent
     * the model in their place (session/clikcode-notice.ts). */
    const userRows = (content: string): readonly string[] => (isClikCodeNotice(content)
      ? clikCodeNoticeRows(content, conversationInner) : messageRows(content, userMarker));
    /** Activity that belongs between two messages rather than inside a turn.
     * Retired once, by identity rather than by text -- two rows that say the
     * same thing are still two rows -- and an entry that arrives after its
     * anchor has been passed is appended where it lands, which is the only
     * thing an append-only transcript can do with it. */
    const standaloneActivity = (anchor: number): string[] => {
      const rows: string[] = [];
      // Folded first: six reads in a row become one row, and the answer they
      // were serving stays on screen.
      if (this.collapsedActivity?.source !== this.activityEntries) {
        this.collapsedActivity = { source: this.activityEntries, entries: collapseToolRuns(this.activityEntries) };
      }
      for (const entry of this.collapsedActivity.entries) {
        if (entry.anchor !== anchor || entry.responseOffset !== undefined) continue;
        const id = entry.sequence;
        if (!this.emitted.claimActivity(id)) continue;
        rows.push(...activityRows(entry.lines, entry.event?.category));
      }
      return rows;
    };
    /** The in-flight turn's tools and steering messages, as rows that settle.
     * A call that is still running is `done: false`: the same slot in the
     * live region, spinner instead of the settled glyph, so finishing it
     * changes the glyph rather than moving the row. At the end of the turn
     * a tool that never reported completion settles anyway. */
    const toolRow = (entry: ActivityEntry, ended: boolean): SettlingTool => {
      const id = entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`;
      const running = !ended && entry.event?.kind === 'tool-start';
      if (!running) {
        return {
          id, done: true, responseOffset: entry.responseOffset,
          lines: activityRows(entry.lines, entry.event?.category),
        };
      }
      const kind = entry.event?.swarm ? 'swarm' as const : (liveWaitKind(entry.event!) ?? 'tool');
      const child = entry.event?.id ? this.childActivity.get(entry.event.id) : undefined;
      const row = runningChatLine(
        tensedLabel(entry.event?.label ?? '', true), this.reducedMotion ? 0 : this.waitingFrame, kind, entry.startedAt ? Date.now() - entry.startedAt : 0,
      ).trim();
      // What it has printed so far, newest last, under the spinner -- a long
      // build or test run is visibly working instead of a bare timer.
      const live = entry.event ? outputPreviewRows({ ...entry.event, outputTail: true }, LIVE_OUTPUT_LINES)
        .map((line) => `  ${visibleSlice(line, Math.max(1, conversationInner - 2))}`) : [];
      return {
        id, done: false, responseOffset: entry.responseOffset,
        lines: ['', `  ${row}`, ...(child ? [`    ${chalk.dim(`${child}${entry.event?.childTools ? ` · ${toolUses(entry.event.childTools)}` : ''}`)}`] : []), ...live, ''],
      };
    };
    /** A run of reads and searches as one row (explore-groups.ts): the
     * summary, and under it the last calls, dimmed. Running, the summary
     * spins in the row's place; settled, it wears the work's glyph. */
    const groupRow = (group: TurnGroup<ActivityEntry & GroupRow>, ended: boolean): SettlingTool => {
      const first = group.members[0]!;
      const { summary, calls, running } = mergedExploreLines(group.members.map((member) => member.event), ended);
      const under = calls.map((call) => `    ${visibleSlice(call, Math.max(1, conversationInner - 4))}`);
      if (running && !group.done) {
        const row = runningChatLine(summary, this.reducedMotion ? 0 : this.waitingFrame, 'tool', first.startedAt ? Date.now() - first.startedAt : 0).trim();
        return { id: group.key, done: false, responseOffset: first.responseOffset, lines: ['', `  ${row}`, ...under, ''] };
      }
      const { line, category } = mergedExploreSummaryLine(group.members.map((member) => member.event), summary);
      return { id: group.key, done: group.done, responseOffset: first.responseOffset, lines: [...activityRows([line], category).slice(0, -1), ...under, ''] };
    };
    /** The turn's rows, looking-around runs merged. A lone call is its own
     * row as always, except that a finished read or search waits in the live
     * region while it is the tail: the next one may merge with it. */
    const groupedRows = (entries: readonly ActivityEntry[], ended: boolean, grouping: ExploreGrouping): SettlingTool[] => {
      const rows = entries.flatMap((entry) => (entry.event ? [{ ...entry, event: entry.event, key: entry.event.id ?? `activity#${entry.sequence ?? entry.responseOffset}` }] : []));
      return grouping.group(rows, ended, ended ? Number.POSITIVE_INFINITY : this.liveResponse.length).map((group) => {
        if (group.merged) return groupRow(group, ended);
        const row = toolRow(group.members[0]!, ended);
        return row.done && !group.done ? { ...row, done: false } : row;
      });
    };
    /** The running turn's own tool calls: anchored at the message count when
     * it began, which is at or before the index its answer lands at. */
    const turnEntries = (anchor: number): ActivityEntry[] => this.activityEntries.filter((entry) =>
      entry.anchor === anchor && entry.responseOffset !== undefined && !entry.event?.parentId);
    /** A saved message's calls, as rows: folded into entries by the same
     * upsert the running turn's events go through, and grouped and drawn by
     * the same functions, so a reopened turn looks as it did live. */
    const savedTools = (message: TranscriptMessage, index: number): SettlingTool[] => {
      const saved = readTurnActivities(message.activities, message.content.length);
      if (!saved.length) return [];
      let entries: ActivityEntry[] = [];
      for (const [position, activity] of saved.entries()) {
        entries = upsertActivityEvent(entries, index, Math.min(activity.responseOffset, message.content.length), activity.event, position + 1, 0);
      }
      return groupedRows(entries, true, new ExploreGrouping());
    };
    const turnTools = (ended: boolean): SettlingTool[] => {
      const tools: SettlingTool[] = groupedRows(turnEntries(this.activityAnchor)
        // An anchor is reused: the next turn's assistant occupies the same
        // index when the previous one was never persisted. The turn that
        // produced an entry is what decides whether it belongs to this one.
        .filter((entry) => (entry.sequence ?? 0) > this.emitted.turnSequenceFloor), ended, this.exploreGrouping);
      // One row on each side, matching every other message: a steer is a
      // message the user wrote mid-answer.
      const steerRows = (text: string): string[] => [
        '', '', ...messageRows(text, userMarker), `  ${chalk.dim(`↳ ${STEER_WORDS.steered}`)}`, '',
      ];
      tools.push(...steerTranscriptRows({
        durable: pending?.steers ?? [], live: this.waitingSubmissions,
        materializedPendingTurn, retiredThisSession: this.emitted.retiredTexts(), render: steerRows,
      }));
      return tools;
    };
    const renderBlocks = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
      renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage);
    const renderLive = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
      renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage, true);

    let reseeding = Boolean(this.emitted.pendingReseed());
    const applyReseed = (): void => {
      if (this.emitted.pendingReseed()) {
        finished.length = 0;
        this.clearTranscript();
        // The first frame of the process, of a newly opened session, or at a
        // new width writes a recent window of the conversation -- enough to
        // fill the viewport and scroll a little. A full-history rewrite made
        // opening a long chat wait on every message before anything drew.
        this.emitted.reseeded();
        this.turnTranscript.reset();
      }
    };
    applyReseed();
    // Where this list carries on from, whether the pending turn is already
    // in it, and where the live answer landed. All three are stated -- with
    // the failures each one prevents -- in render/transcript-seam.ts.
    // A list that no longer contains the row on screen is rewritten from
    // the list. Matching that row's text is what duplicated a live turn.
    let resume = this.emitted.resume(persistedMessages);
    if (resume.diverged) {
      reseeding = true;
      applyReseed();
      resume = this.emitted.resume(persistedMessages);
    }
    let { firstUnwritten, materializedPendingTurn } = resume;
    // Cleared below once the live answer has been consumed, so it stays a let.
    let liveAssistant = resume.liveAssistant;
    // A reseed of a long chat only paints a recent window. Older messages are
    // marked written so the seam stays honest; they are not in
    // alternateTranscript (same trade-off as its row cap). The first frame
    // then costs O(viewport), not O(history).
    if (reseeding && firstUnwritten === 0 && persistedMessages.length > 0) {
      // A /search mention further back than that starts the window there.
      const focus = this.mentionFocus?.sessionId === session.id ? this.mentionFocus.messageIndex : undefined;
      const recent = reseedStartIndex(persistedMessages, ALTERNATE_TRANSCRIPT_ROWS, conversationInner);
      const from = focus === undefined ? recent : Math.min(recent, Math.max(0, focus - 1));
      if (from > 0) {
        for (let index = 0; index < from; index += 1) this.emitted.wrote(persistedMessages[index]!);
        this.emitted.settle(from);
        firstUnwritten = from;
        if (liveAssistant !== undefined && liveAssistant < from) liveAssistant = undefined;
      }
    }

    emit(standaloneActivity(firstUnwritten));
    // The turn this window drew live has all its calls on screen already: a
    // steer splits its saved answer into several messages, and the ones after
    // the first must not draw those calls a second time.
    let drewLiveTurn = false;
    for (let index = firstUnwritten; index < persistedMessages.length; index += 1) {
      const message = persistedMessages[index]!;
      this.messageLines.set(index, this.alternateTrimmed + this.alternateTranscript.length + this.pendingFinished.length + finished.length);
      const pastTools = message.role === 'assistant' && index !== liveAssistant && !drewLiveTurn ? savedTools(message, index) : [];
      if (index === liveAssistant && message.role === 'assistant') {
        // The answer that just streamed. Its rows are already in scrollback and
        // the transcript knows exactly which blocks it still owes, so a
        // persisted copy that runs longer than what streamed -- a re-derived
        // answer, an interrupted turn -- contributes only its tail, and one
        // identical to what streamed contributes nothing at all.
        emit(this.turnTranscript.advance({
          content: sanitizeTerminalText(message.content), tools: turnTools(true), turnEnded: true, renderBlocks,
        }).finished);
      } else if (pastTools.length) {
        // A saved turn: its calls go back where they happened, between the
        // paragraphs, as they were drawn while it ran.
        emit(new TurnTranscript().advance({
          content: sanitizeTerminalText(stripRepeatedTitles(message.content)), tools: pastTools,
          turnEnded: true, renderBlocks,
        }).finished);
      } else {
        // A change of speaker is a bigger break than a change of paragraph.
        // Every gap in the transcript was one row -- between messages and
        // between the blocks inside them alike -- so a new question read as
        // just another paragraph of the answer above it. Reported as "no
        // buffer" repeatedly, and it was: the buffer was there, it just
        // measured the same as everything else. Never at the very top, where
        // there is nothing to separate from.
        if (message.role === 'user' && index > 0) emit(['']);
        // A title tag never renders, however it got into the saved reply: a
        // vendor that repeated its first reply's tag, or an older transcript.
        emit(message.role === 'assistant'
          ? messageRows(stripRepeatedTitles(message.content), '·')
          : userRows(message.content));
      }
      if (index === liveAssistant) {
        this.emitted.liveAnswerSettled();
        liveAssistant = undefined;
        drewLiveTurn = true;
        this.turnTranscript.reset();
      }
      this.emitted.wrote(message);
      emit(['']);
      emit(standaloneActivity(index + 1));
    }
    this.emitted.settle(persistedMessages.length);

    const liveConversation: string[] = [];
    if (hasTransientAssistant) {
      this.emitted.liveAssistantIndex = this.emitted.writtenCount();
      const content = sanitizeTerminalText(this.liveResponse);
      const step = this.turnTranscript.advance({
        content,
        // The live answer is lexed from its last blank-line boundary rather
        // than re-parsed from the top on every delta.
        blocks: this.streamingBlocks(content),
        tools: turnTools(!this.turn),
        turnEnded: !this.turn,
        renderBlocks,
        renderLive,
      });
      emit(step.finished);
      liveConversation.push(...step.live);
    }
    // The turn's last line, once its answer has settled above it. Retired
    // like every other row, exactly once: it is dropped as it is written.
    const answered = persistedMessages.length > this.activityAnchor && persistedMessages[persistedMessages.length - 1]?.role === 'assistant';
    if (this.pendingTurnSummary && !this.turn && (hasTransientAssistant || answered)) {
      emit(['', `  ${chalk.dim(`─ ${this.pendingTurnSummary} ─`)}`, '']);
      this.pendingTurnSummary = undefined;
    }
    for (const [queueIndex, message] of queuedMessages.entries()) {
      // Provisional, and so never retired: a queued turn becomes a real user
      // message the moment it is sent, and would then be written a second time.
      const status = message.queueState === 'steered' ? STEER_WORDS.steered
        : message.queueState === 'sending' ? 'submitting…'
          : message.queueState === 'pause' ? `${STEER_WORDS.held}${sendNowHint}`
            : message.queueState === 'error' ? 'not sent · restored for editing'
              : `queued for next turn${message.unsteered ? ` · ${STEER_WORDS.unsteered}` : ''}${sendNowHint}`;
      // One row, the same separator the transcript gives every other message:
      // a message submitted mid-turn is still a message the user wrote.
      // The speaker changes once, where the queue begins: two rows there, the
      // same break a settled prompt gets. Between queued messages it is one --
      // they are a list of things the same person wrote, not a new speaker
      // each time.
      liveConversation.push(...(queueIndex === 0 ? ['', ''] : ['']),
        ...userRows(message.content), `  ${chalk.dim(`↳ ${status}`)}`);
    }
    const conversationLines = liveConversationLines(liveConversation, true);
    const meta = this.statusText();
    const footer: string[] = [];
    // The resting composer starts with a clear row, or its rule sits directly
    // on the last line of the answer. While a turn runs the generating band
    // already carries its own blank, budgeted into the height -- adding a
    // second one there would double the gap and push an answer row off.
    if (!this.turn) footer.push('');
    if (noticeRows && notice) footer.push(`  ${chalk.yellow(visibleSlice(notice, inner))}`);
    if (paletteCapacity) {
      footer.push(...paletteBandRows(options as readonly PaletteEntry[], selected, paletteCapacity, width, {
        ...(palette?.headings ? { headings: true } : {}), ...(palette?.hint ? { hint: palette.hint } : {}),
      }));
    }
    footer.push(...panelRows, ...planRows, ...approvalRows, ...thoughtRows, ...(signInRows.length ? ['', ...signInRows] : []));
    if (waitingRows && this.turn) {
      footer.push('', `  ${visibleSlice(this.waitingLine(this.turn), Math.max(1, inner))}`);
    }
    // Usage lives on the upper composer border, mirroring the title on the
    // lower border. A spent window replaces the percentage with the reset
    // itself (`Resets 5:34PM`); a spent balance says `Out Of Credits`.
    footer.push(paintUsageRule(rowWidth, composerUsageLabel(this.usageLabel, this.usageResetLabel)));
    const composerStart = footer.length;
    for (const [index, row] of composerRows.rows.entries()) {
      // The caret is drawn in the same foreground as the rules and the text
      // between them, so the whole composer reads as one field: white frame,
      // white prompt, white input.
      footer.push(`  ${index === 0 ? chalk.bold(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
    }
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    footer.push(paintTitleRule(rowWidth, session.name || undefined));
    // Provider, model, effort and directory are one statement -- what this
    // conversation is running as -- so they read as one line in one colour
    // rather than a bright word followed by a dimmer tail. Cyan is ClikCode's
    // own chrome, the same family as the caret above it.
    footer.push(`  ${chalk.cyan(visibleSlice(meta, inner))}`);

    // The live region is bounded by the viewport: it is erased and redrawn as
    // one block every frame, so it can never be taller than the terminal. A
    // construct that settles only when it closes -- a table still receiving
    // rows -- shows its tail until then, and every row of it is written on the
    // frame the block completes.
    // Scrolled back, the live conversation gives up ALL its rows, not just
    // some. flushAlternateFrame already states this intent -- "the live
    // region gives up its rows to the transcript" -- but it only achieved it
    // implicitly, through `above = height - live.length`, so whatever the
    // answer was still streaming kept a few rows and painted them directly
    // above the composer. That is the tail of a sentence being written,
    // changing several times a second, at the bottom of a page someone is
    // reading: it reads as the screen glitching, and it is the one thing on
    // screen they did not ask to look at.
    //
    // The waiting band above deliberately does NOT do this. A spinner and an
    // elapsed clock in a fixed place answer "is it still working" without
    // competing for the eye; a sentence rewriting itself does. Only the words
    // go.
    const maxLiveConversation = this.scrolledBack ? 0 : Math.max(0, targetHeight - footer.length);
    const liveConversationRows = Math.min(conversationLines.length, maxLiveConversation);
    const unbounded = [...(maxLiveConversation ? conversationLines.slice(-maxLiveConversation) : []), ...footer];
    // The hard invariant every relative motion in a frame depends on: the
    // live region fits on screen. maxLiveConversation only bounds the
    // conversation half, so a footer taller than the viewport (a palette and
    // an approval block on a short phone screen) would still overflow, and an
    // overflowing block cannot be walked back up -- the terminal stops at its
    // top row and the cursor stays that many rows low. Dropping from the top
    // costs context; not dropping costs a working cursor.
    const overflow = Math.max(0, unbounded.length - targetHeight);
    const live = overflow ? unbounded.slice(overflow) : unbounded;
    // The composer's own row and column, whether or not the frame shows the
    // cursor: a phone client draws its caret wherever it was left, hidden or
    // not (see flushAlternateFrame). The block's last row is the status line, and a
    // caret parked there is the one every report of "the cursor is under the
    // composer" is actually describing.
    const cursorRow = Math.max(0, liveConversationRows + composerStart + composerRows.cursorRow - overflow);
    const cursorColumn = 3 + terminalCellWidth(prompt) + composerRows.cursorWidth;
    this.pendingSignals += this.terminalSignals();
    this.renderFrame(finished, live, cursorRow, cursorColumn, Boolean(palette?.hideCursor));
  }

  /** The last frame's live rows made safe, by the row as built and the width. */
  private safeLiveRows = { limit: 0, rows: new Map<string, string>() };

  /** One frame: `finished` rows are retired into the transcript, and the live
   * region below them is replaced. */
  private renderFrame(
    finished: readonly string[], live: readonly string[], cursorRow: number, cursorColumn: number, hideCursor: boolean,
  ): void {
    // Last line of defence: whatever produced a row, the only escape sequences
    // that reach the terminal are SGR colors, no row contains a control
    // character that would move the cursor out from under the live region, and
    // no row reaches the terminal's last column -- a row that fills it wraps
    // into a second one wherever DECAWM-off is not honoured, and every
    // relative motion in the frame after it is then one row out. The layout
    // above already budgets for this; clipping here means a new row builder
    // cannot reintroduce it.
    const limit = Math.max(1, (output.columns || 100) - 1);
    const safeRow = (row: string): string =>
      closeOpenHyperlink(visibleSlice(sanitizeTerminalText(row, { keepSgr: true, singleLine: true }), limit));
    // Most live rows are the same from one frame to the next (the footer, the
    // answer's settled lines), so each is made safe once while it stays.
    const known = this.safeLiveRows.limit === limit ? this.safeLiveRows.rows : new Map<string, string>();
    const rows = new Map<string, string>();
    const safeLive = live.map((row) => {
      const safe = known.get(row) ?? safeRow(row);
      rows.set(row, safe);
      return safe;
    });
    this.safeLiveRows = { limit, rows };
    // Frames that coalesce while a write drains accumulate their finished rows
    // instead of replacing them. A live row dropped here is drawn again by the
    // frame that replaces it; a retired row would simply be lost.
    this.pendingFinished.push(...finished.map(safeRow));
    this.pendingLive = { live: safeLive, cursorRow, cursorColumn, hideCursor };
    if (!this.frameInFlight) this.flushFrame();
  }

  private flushFrame(): void {
    if (this.closed || this.suspended) return;
    // A streaming answer may request a frame while the phone is still
    // changing size. Keep its durable rows, but wait for the final geometry
    // before drawing; repaintAfterResize supplies the fresh live rows.
    if (this.resizePaintTimer) return;
    const pending = this.pendingLive;
    if (!pending) return;
    this.pendingLive = undefined;
    const finished = this.pendingFinished;
    this.pendingFinished = [];
    if (finished.length) {
      this.secondLastFinishedRow = finished.length > 1 ? finished[finished.length - 2] : this.lastFinishedRow;
      this.lastFinishedRow = finished[finished.length - 1];
    }
    this.flushAlternateFrame(finished, pending);
  }

  /** One screen, every row at an address.
   *
   * Retired rows go into `alternateTranscript` instead of the terminal's
   * scrollback, the viewport shows its tail above the live region, and the
   * cursor is parked with an absolute jump. Nothing here counts rows the
   * terminal might count differently, so nothing here can drift. */
  private flushAlternateFrame(
    finished: readonly string[],
    pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean },
  ): void {
    if (finished.length) {
      this.alternateTranscript.push(...finished);
      // Someone reading stays where they are. The offset counts rows from the
      // end of the transcript, so rows arriving at that end move the window
      // forward by one per row -- the text walks out from under the reader
      // while a turn streams, which is what "scrolling slips through previous
      // messages" is. Growing the offset by the same count holds it still.
      if (this.alternateScrollback > 0) this.alternateScrollback += finished.length;
      // Trimming the front does not move the end, so it leaves the offset be.
      // Never past a /search mention being looked at: a long way back in a
      // long chat is exactly where one can be.
      const focusLine = this.mentionFocus ? this.messageLines.get(this.mentionFocus.messageIndex) : undefined;
      const excess = Math.min(this.alternateTranscript.length - ALTERNATE_TRANSCRIPT_ROWS,
        focusLine === undefined ? Number.POSITIVE_INFINITY : focusLine - this.alternateTrimmed);
      if (excess > 0) {
        this.alternateTranscript.splice(0, excess);
        this.alternateTrimmed += excess;
      }
    }
    const height = this.viewportRows();
    const live = pending.live.slice(-height);
    const above = Math.max(0, height - live.length);
    this.alternateAbove = above;
    // Scrolled back, the live region gives up its rows to the transcript:
    // looking at what went past is the whole point, and the composer is not
    // what is being read. A frame at offset zero is the conversation as it
    // happens.
    // How far back this screen can actually show, which is not how far back
    // the offset is allowed to go: `above` is the rows the transcript gets,
    // and it grows with the screen. A phone hiding its keyboard hands back a
    // third of the screen at once, so an offset that was inside the range a
    // moment ago is suddenly past its end -- and every further swipe moves a
    // number while the view stays pinned at the top, which reads as scrolling
    // having stopped working. The offset is clamped to what can be shown.
    this.jumpToMention(above);
    const furthest = Math.max(0, this.alternateTranscript.length - above);
    this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
    const scrolled = this.alternateScrollback;
    const first = Math.max(0, this.alternateTranscript.length - above - scrolled);
    const shownTranscript = this.alternateTranscript.slice(first, this.alternateTranscript.length - scrolled);
    const shownLive = scrolled > 0 ? live.slice(0, Math.max(0, height - above)) : live;
    let rows = [...shownTranscript, ...shownLive];
    while (rows.length < height) rows.unshift('');
    this.frameLayout = { live: [...live] };
    if (this.mentionFocus?.words.length) {
      const words = this.mentionFocus.words;
      const transcriptRows = rows.length - shownLive.length;
      rows = rows.map((row, index) => (index < transcriptRows ? highlightWords(row, words) : row));
    }
    if (this.selection) rows = highlightSelectionAt(rows, rows.map((_, row) => this.lineAtScreenRow(row)), this.selection);
    // Only what changed. A keystroke changes the composer's row and nothing
    // else, and rewriting the whole screen for it costs kilobytes per key on
    // a phone link -- long enough for a client's own prediction popup to
    // appear in the gap before the echo lands. Each row is addressed, so a
    // partial update is exactly as safe as a whole one, which is the point of
    // drawing here. `EL` per row: replaced, never overprinted.
    const full = this.alternatePrevious.length !== rows.length;
    // A scroll is a shift, and the terminal can do a shift itself.
    //
    // Row by row, a scroll changes every row on screen, so the diff below
    // rewrites the whole thing: about 3.3KB at 63 rows against 1.6KB at 32 --
    // and 63 rows is the keyboard-hidden height, the one case that never
    // worked. The same UI drawing ~0.8KB frames receives the gesture at both
    // heights. Cost per frame is the difference, and it scales with the screen.
    //
    // So when the new screen is the old one shifted -- which is exactly what a
    // scroll produces -- the shift is handed to the terminal (SU/SD inside a
    // region covering the transcript) and only the rows it exposed are drawn.
    // Three rows instead of sixty-three.
    //
    // Claude Code never rewrites whole rows either: 4,182 relative motions in
    // one captured session against 347 absolute jumps. This UI had zero.
    // Only a transcript scroll hands the movement to the terminal. Other
    // screens that happen to look shifted -- a palette opening, a picker
    // closing -- are drawn, because SU inside a region discards what it pushes
    // out and those are not rows this code can redraw from its own transcript.
    const scrolling = this.paintingScroll;
    this.paintingScroll = false;
    const shift = full || !scrolling ? 0 : scrollShift(this.alternatePrevious, rows, above);
    const updates: string[] = [];
    // Rows the shift already drew, so the diff below does not draw them twice
    // -- a frame carrying the same row twice is a duplicated prompt on screen.
    let exposedFrom = -1;
    let exposedTo = -1;
    if (shift !== 0) {
      const span = Math.abs(shift);
      // Region over the transcript only, so the live region stays put; reset
      // straight after, because a region left set confines every later frame.
      updates.push(`\u001b[1;${above}r`);
      updates.push(shift > 0 ? `\u001b[${span}S` : `\u001b[${span}T`);
      updates.push('\u001b[r');
      const exposed = shift > 0 ? rows.slice(above - span, above) : rows.slice(0, span);
      exposedFrom = shift > 0 ? above - span : 0;
      exposedTo = exposedFrom + span;
      for (const [offset, row] of exposed.entries()) {
        updates.push(`\u001b[${exposedFrom + offset + 1};1H${row}\u001b[K`);
      }
    }
    for (const [index, row] of rows.entries()) {
      if (!full && this.alternatePrevious[index] === row) continue;
      if (index >= exposedFrom && index < exposedTo) continue;
      if (shift !== 0 && index < above && shiftedRow(this.alternatePrevious, index, shift) === row) continue;
      updates.push(`\u001b[${index + 1};1H${row}\u001b[K`);
    }
    this.alternatePrevious = rows;
    const composerRow = rows.length - live.length + pending.cursorRow + 1;
    // Parked whether or not the cursor is shown. DECTCEM is a request, and a
    // client that draws its own caret regardless (phone clients do) puts it
    // wherever this code last left it -- which, unparked, is the end of the
    // block's last row: the status line, under the composer. Only the `?25h`
    // below depends on whether the frame shows it.
    const park = `\u001b[${Math.max(1, Math.min(height, composerRow))};${Math.max(1, pending.cursorColumn)}H`;
    const modes = takeQueuedModes();
    const signals = this.pendingSignals;
    this.pendingSignals = '';
    const showCursor = !pending.hideCursor;
    // Nothing changed: nothing is written. A clock that ticks every second
    // used to send a cursor hide, a park and a show each time regardless.
    if (!updates.length && !modes && !signals && park === this.lastPark && showCursor === this.cursorShown) return;
    // The preamble goes with rows, never alone: a clear with nothing after
    // it would only blank the screen, so a resize or repair waits for them.
    const draw = updates.length ? `${redrawPreamble(this.provisionalFrame ? undefined : this.pendingRedraw)}${updates.join('')}` : '';
    if (updates.length && !this.provisionalFrame) this.pendingRedraw = undefined;
    const cursor = showCursor && (updates.length || !this.cursorShown) ? '\u001b[?25h'
      : !showCursor && !updates.length && this.cursorShown !== false ? '\u001b[?25l' : '';
    // One synchronized update (DEC 2026): a terminal that supports it shows
    // the frame whole or not at all, never half-drawn; one that does not
    // ignores the two sequences. restoreTerminal closes it on any exit.
    const frame = `\u001b[?2026h${modes}${signals}${draw}${park}${cursor}\u001b[?2026l`;
    this.lastPark = park;
    this.cursorShown = showCursor;
    this.frameInFlight = true;
    terminalModes.painted = true;
    logCursorEvent(`alternate frame: height=${height} rows=${updates.length}/${rows.length} composer=${composerRow} col=${pending.cursorColumn}`);
    output.write(frame, () => {
      this.frameInFlight = false;
      if (this.pendingLive && !this.closed && !this.suspended) this.flushFrame();
    });
  }

  /** /search: show `session` at one mention, its words highlighted and
   * `focus.status` under it. The view moves to the mention on the frame
   * that draws it -- rewriting the conversation from an earlier message
   * first when the mention is older than what is on screen. */
  showMention(session: HarnessSession, focus: MentionFocus): void {
    this.mentionFocus = { ...focus, sessionId: session.id, jumped: false };
    if (this.currentSession?.id === session.id && !this.messageLines.has(focus.messageIndex)) this.emitted.requestReseed();
    this.render(session);
  }

  /** The next key while browsing mentions: Up/Down move between them, Tab
   * goes to the next conversation, Esc (or Enter) ends it. Page keys and
   * the wheel still scroll. */
  mentionKey(): Promise<'next' | 'previous' | 'chat' | 'done'> {
    return new Promise((resolve) => {
      let stop: () => void = () => {};
      const listen = (): void => {
        stop = takeTerminalKeys((key) => {
          const action = key === '\u001b[A' ? 'previous' as const : key === '\u001b[B' ? 'next' as const : key === '\t' ? 'chat' as const
            : key === '\u001b' || key === '\r' || key === '\u0003' ? 'done' as const : undefined;
          if (!action) {
            if (key === '\u000c') { this.requestRedraw('repair'); this.forgetScreenPosition(); this.repaint(); return; }
            this.handleScrollKey(key);
            return;
          }
          stop();
          this.resumeInput = undefined;
          output.write(popReadModes());
          resolve(action);
        });
        output.write(enterInputModes());
      };
      this.resumeInput = () => { stop(); listen(); };
      listen();
    });
  }

  /** Browsing is over: the view stays at the mention, its words stay
   * highlighted until the next line is sent, and the status line goes. */
  endMention(): void {
    if (!this.mentionFocus) return;
    this.mentionFocus = { ...this.mentionFocus, status: undefined };
    this.repaint();
  }

  /** Puts the mention a few rows below the top of the view, once, on the
   * first frame whose transcript holds it. */
  private jumpToMention(above: number): void {
    const focus = this.mentionFocus;
    if (!focus || focus.jumped || this.currentSession?.id !== focus.sessionId) return;
    const start = this.messageLines.get(focus.messageIndex);
    if (start === undefined) return;
    const from = start - this.alternateTrimmed;
    if (from < 0 || from >= this.alternateTranscript.length) return;
    const nextStart = this.messageLines.get(focus.messageIndex + 1);
    const to = nextStart === undefined ? this.alternateTranscript.length : Math.min(this.alternateTranscript.length, nextStart - this.alternateTrimmed);
    const found = focus.words[0] ? rowOfOccurrence(this.alternateTranscript.slice(from, to), focus.words[0], focus.occurrence) : undefined;
    const row = from + (found ?? 0);
    const first = Math.max(0, row - 3);
    this.alternateScrollback = Math.max(0, this.alternateTranscript.length - above - first);
    focus.jumped = true;
  }

  /** Move the viewport through the transcript. Positive scrolls back, and the
   * conversation is followed again at zero, which every new frame returns to
   * by itself once the reader lets go. Returns whether anything moved, so a
   * key that cannot scroll any further still means something to the caller. */
  private scrollTranscript(rows: number): boolean {
    // Bounded by what the CURRENT screen can show -- see flushAlternateFrame.
    // Bounding it by the transcript's length instead let the offset run past
    // the end of what any frame would draw, and the rows a reader then had to
    // swipe back through before the view moved again were rows that were
    // never on it.
    const furthest = Math.max(0, this.alternateTranscript.length - this.alternateAbove);
    const next = Math.max(0, Math.min(furthest, this.alternateScrollback + rows));
    // What a report of "it did not move" needs to be answerable: whether the
    // key arrived (logged where keys are read), and whether there was anywhere
    // to go -- a screen tall enough to show the whole transcript has nothing
    // hidden above it, and refusing to move is then the right answer.
    logCursorEvent(`scroll by=${rows} from=${this.alternateScrollback} to=${next} furthest=${furthest} rows=${this.alternateTranscript.length} above=${this.alternateAbove}`);
    if (next === this.alternateScrollback) return false;
    this.alternateScrollback = next;
    this.paintingScroll = true;
    this.scheduleScrollPaint();
    return true;
  }

  /** How much of a pending scroll to apply now, carrying the rest.
   *
   * Transcribed from Claude Code's proportional drain, which is what it runs
   * on a terminal that is not xterm.js:
   *
   *     const step = Math.min(height - 1, Math.max(4, |delta| * 3 >> 2));
   *     if (|delta| <= step) return delta;          // small moves land whole
   *     pending = delta - step; return step;        // the rest drains later
   *
   * Three quarters of what is outstanding, never more than a screenful in one
   * frame, and at least four rows so it always finishes. A single notch is
   * three rows and lands whole and at once; a flick of three hundred notches
   * becomes a handful of bounded frames instead of three hundred full
   * repaints, which is what made the client stop forwarding the gesture. */
  private pendingScroll = 0;
  /** True while the frame being drawn is the result of a scroll. */
  private paintingScroll = false;
  private scrollDrainTimer?: NodeJS.Timeout;
  private drainScroll(): void {
    if (this.closed || this.suspended || !this.pendingScroll) return;
    const magnitude = Math.abs(this.pendingScroll);
    const step = Math.min(Math.max(1, this.viewportRows() - 1), Math.max(SCROLL_DRAIN_MIN, (magnitude * 3) >> 2));
    const applied = magnitude <= step ? this.pendingScroll : (this.pendingScroll > 0 ? step : -step);
    this.pendingScroll -= applied;
    const moved = this.scrollTranscript(applied);
    // Nowhere further to go: drop the rest rather than drain against the end.
    if (!moved) this.pendingScroll = 0;
    if (!this.pendingScroll || this.scrollDrainTimer) return;
    this.scrollDrainTimer = setTimeout(() => {
      this.scrollDrainTimer = undefined;
      this.drainScroll();
    }, SCROLL_DRAIN_MS);
    this.scrollDrainTimer.unref();
  }

  /** Wheel notches go here, not straight to the viewport. */
  private queueScroll(rows: number): void {
    this.pendingScroll += rows;
    if (inKeyBatch()) this.drainAtBatchEnd();
    else this.drainScroll();
  }

  private stopDrainBatch?: () => void;
  private drainAtBatchEnd(): void {
    this.stopDrainBatch ??= onKeyBatchEnd(() => this.drainScroll());
  }

  /** One repaint per burst of wheel notches, not one per notch.
   *
   * A flick on a phone is not a few notches, it is momentum: the client
   * delivers them in bursts of three hundred and more, measured here in single
   * reads of over a thousand. Painting per notch asked the link to carry a
   * full-screen repaint for each -- in a long conversation that is about 4KB a
   * frame, so one flick is upwards of a megabyte, and the client stops
   * forwarding the gesture rather than fall further behind.
   *
   * That is the whole bug, and it is why it depended on the conversation:
   * measured on the device, a fresh chat (246 transcript rows, small frames)
   * took 221 wheel reports with the keyboard hidden, and this conversation
   * (2000 rows, full-width styled frames) took none. The same shape showed up
   * in a bare script -- plain rows 46,048 reports, styled 4KB rows 3,751.
   *
   * The offset is still updated per notch, so nothing is lost and the view
   * lands exactly where the finger left it; only the drawing is coalesced. */
  private scrollPaintQueued = false;
  private stopScrollBatch?: () => void;
  private scheduleScrollPaint(): void {
    const draw = (): void => {
      this.scrollPaintQueued = false;
      if (this.closed || this.suspended) return;
      this.repaint();
    };
    // Inside a batch the frame waits for the end of the chunk; outside one --
    // a page key, an arrow, a test pressing a single key -- it draws at once.
    if (!inKeyBatch()) { draw(); return; }
    this.scrollPaintQueued = true;
    this.stopScrollBatch ??= onKeyBatchEnd(() => { if (this.scrollPaintQueued) draw(); });
  }

  /** True while the reader is looking at something other than the live end. */
  private get scrolledBack(): boolean { return this.alternateScrollback > 0; }

  /** Keys that move the transcript rather than the draft, in the one place
   * both the prompt and the waiting band read them from. Reading back is
   * wanted most while a turn runs -- which is the half that had no scrolling
   * at all, so a page key or a wheel notch reached the draft editor instead.
   * Returns whether the key was spent here. */
  private handleScrollKey(key: string): boolean {
    if (isMouseEvent(key)) {
      // A left press, drag or release is a selection ClikCode makes itself:
      // with mouse reporting on, the terminal's own selection never sees it.
      const action = selectionAction(key);
      if (action) { this.handleSelection(action); return true; }
      // Every other mouse report is consumed too, wheel or not: none of them
      // belongs to the composer.
      const rows = wheelScrollRows(key);
      // Queued and drained -- a flick is hundreds of notches in one read.
      if (rows) this.queueScroll(rows);
      return true;
    }
    const page = Math.max(1, this.viewportRows() - 3);
    if (key === '\u001b[5~') { this.scrollTranscript(page); return true; }
    if (key === '\u001b[6~') { this.scrollTranscript(-page); return true; }
    // Ctrl+B and Ctrl+F, a page at a time, as less and vi have always read.
    //
    // A phone keyboard has no page keys, but its key bar has ctrl, so these
    // two are reachable by hand where PageUp and PageDown are not.
    if (key === '\u0002') { this.scrollTranscript(page); return true; }
    if (key === '\u0006') { if (!this.scrollTranscript(-page)) this.noteReadingDirection(); return true; }
    return false;
  }

  /** Press starts a selection, drag extends it, release copies it. A click
   * that never moved selects nothing and copies nothing. No confirmation is
   * shown: the highlight is what was selected, and it clears when the text is
   * on the clipboard. Only a failure to copy says anything. */
  private handleSelection(action: MouseAction): void {
    // Scrolled back, the rows below the conversation are the composer and the
    // status line: a drag reaching them is reaching for the conversation's
    // next line, which the edge scroll brings up, not for the chrome.
    const intoChrome = this.alternateScrollback > 0 && action.kind !== 'press' && action.at.row >= this.alternateAbove;
    const at = intoChrome
      ? { row: this.lineAtScreenRow(Math.max(0, this.alternateAbove - 1)), col: Number.MAX_SAFE_INTEGER }
      : { row: this.lineAtScreenRow(action.at.row), col: action.at.col };
    if (action.kind === 'press') {
      this.stopSelectionScroll();
      if (!Number.isFinite(at.row)) return;
      this.selection = { anchor: at, head: at };
      return;
    }
    const selection = this.selection;
    if (!selection) return;
    if (Number.isFinite(at.row)) selection.head = at;
    if (action.kind === 'drag') {
      this.followSelectionEdge(action.at.row, action.at.col);
      this.redrawSelection();
      return;
    }
    this.stopSelectionScroll();
    this.selection = undefined;
    if (selectionIsEmpty(selection)) return;
    const text = this.selectionText(selection);
    this.redrawSelection();
    if (!text) return;
    void copyToClipboard(text).catch((error: unknown) => {
      this.showTransientNotice(userError('copy', error), NOTICE_MS, () => this.redrawSelection());
      this.redrawSelection();
    });
  }

  /** The conversation line screen row `row` shows (see render/selection.ts),
   * from where the view is now, not from the last frame drawn: a scroll's
   * repaint lands a moment after the scroll, and a release in between was
   * placed by the old layout -- the selection snapped back to where the drag
   * reached the edge. */
  private lineAtScreenRow(row: number): number {
    return lineAtRow({
      length: this.alternateTranscript.length, trimmed: this.alternateTrimmed,
      above: this.alternateAbove, scrollback: this.alternateScrollback,
    }, row);
  }

  /** What a selection copies, read from the conversation itself -- all of it,
   * including the lines scrolled out of view while it was being made. */
  private selectionText(selection: Selection): string {
    const range = orderedRange(selection);
    const rows: string[] = [];
    for (let line = range.start.row; line <= range.end.row; line += 1) {
      rows.push(lineText(line, this.alternateTranscript, this.alternateTrimmed, this.frameLayout.live));
    }
    const shift = (cell: { row: number; col: number }) => ({ row: cell.row - range.start.row, col: cell.col });
    return selectedText(rows, { anchor: shift(selection.anchor), head: shift(selection.head) });
  }

  /** A drag resting on the top row scrolls back; one resting on the bottom of
   * the conversation while it is scrolled back scrolls forward. Anywhere else
   * stops. The terminal sends a drag report only when the pointer moves, so
   * a timer carries the scroll while it is held still at the edge. */
  private followSelectionEdge(row: number, col: number): void {
    const bottom = Math.max(0, this.alternateAbove - 1);
    const direction: 1 | -1 | 0 = row <= 0 ? 1 : row >= bottom && this.alternateScrollback > 0 ? -1 : 0;
    if (!direction) { this.stopSelectionScroll(); return; }
    if (this.selectionScroll?.direction === direction) { this.selectionScroll.col = col; return; }
    this.stopSelectionScroll();
    const timer = setInterval(() => this.stepSelectionScroll(), SELECTION_SCROLL_MS);
    timer.unref?.();
    this.selectionScroll = { timer, direction, col };
    this.stepSelectionScroll();
  }

  private stepSelectionScroll(): void {
    const scroll = this.selectionScroll;
    const selection = this.selection;
    if (!scroll || !selection || this.closed || this.suspended) { this.stopSelectionScroll(); return; }
    const before = this.alternateScrollback;
    if (!this.scrollTranscript(scroll.direction)) { this.stopSelectionScroll(); return; }
    // The line under the resting pointer moved by however far the view did.
    const moved = this.alternateScrollback - before;
    selection.head = { row: selection.head.row - moved, col: scroll.direction < 0 ? Number.MAX_SAFE_INTEGER : scroll.col };
  }

  private stopSelectionScroll(): void {
    if (!this.selectionScroll) return;
    clearInterval(this.selectionScroll.timer);
    this.selectionScroll = undefined;
  }

  /** The current frame again, so the highlight follows the pointer. */
  private redrawSelection(): void {
    if (this.closed || this.suspended || this.selecting) return;
    if (this.turn) this.paintWaiting(this.turn);
    else this.repaint();
  }

  /** Down at the live end moves nothing, and says so.
   *
   * There is nothing newer than the newest, so the key is a correct no-op --
   * and an invisible one, which is worse than useless when the only way to
   * read back on a client is its arrow keys: the request looks like a broken
   * feature rather than a wrong direction. Inverting it instead was tried and
   * is worse, because then nothing settles at the live end: every press
   * bounces back into the history. So it stays a no-op, and it tells the
   * reader which way to go. */
  private noteReadingDirection(): boolean {
    if (this.scrolledBack || this.alternateTranscript.length === 0) return false;
    this.showTransientNotice(
      '↑ or Ctrl+B to read earlier messages',
      2000,
      () => this.repaint(),
    );
    this.repaint();
    return true;
  }

  /** Forget where on screen the live block sits: whoever writes next (the
   * shell, a vendor CLI, a resize) decides that now. */
  private forgetScreenPosition(): void {
    this.alternatePrevious = [];
    this.cursorShown = undefined;
  }

  notice(text: string): void {
    this.showTransientNotice(text, NOTICE_MS, () => this.repaint());
    this.repaint();
  }

  private showTransientNotice(text: string, durationMs: number, redraw: () => void): void {
    this.clearTransientNotice();
    this.transientNotice = text;
    this.transientNoticeTimer = setTimeout(() => {
      this.transientNoticeTimer = undefined;
      this.transientNotice = undefined;
      if (!this.closed && !this.suspended) redraw();
    }, durationMs);
    this.transientNoticeTimer.unref();
  }

  private clearTransientNotice(): void {
    if (this.transientNoticeTimer) clearTimeout(this.transientNoticeTimer);
    this.transientNoticeTimer = undefined;
    this.transientNotice = undefined;
  }

  /** Ctrl+Z. Raw mode swallows the terminal's own job control, so do what it
   * would have done: give the terminal back exactly as close() would, stop
   * this process, and rebuild the live region below whatever the shell printed
   * once `fg` continues it. */
  private suspendToShell(): void {
    if (this.suspended || this.closed) return;
    this.suspended = true;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.pendingLive = undefined;
    setTerminalRawMode(false);
    // Whoever takes the terminal takes the main screen with it: a vendor
    // login prompt drawn on our alternate screen would vanish with it.
    output.write(sessionModesOff(true));
    terminalModes.alternateScreen = false;
    process.once('SIGCONT', this.onContinue);
    process.kill(process.pid, 'SIGTSTP');
  }

  private readonly onContinue = (): void => {
    if (this.closed) return;
    this.retakeScreen();
    this.resumeInput?.();
    if (this.turn) this.paint(this.turn.draft, [], 0, '› ', this.turn.cursor);
    else this.repaint();
  };

  /** Remove a completed palette/picker as one frame. Painting an empty
   * composer here left its borders/status rows alive while the selected slash
   * command ran, which looked like a composer floating above blank space. */
  private clearInteractiveFrame(): void {
    this.renderFrame([], [], 0, 1, true);
  }

  async question(
    prompt: string,
    commands: readonly PaletteEntry[] = [],
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean; leftArrowCommand?: string; signal?: AbortSignal; secret?: boolean },
  ): Promise<string> {
    // Kept for the turn this prompt's answer starts: a turn in flight offers
    // the same commands, and this is where they are known.
    this.paletteCommands = commands;
    // Node sets isTTY once when it creates process.stdin and never changes
    // it, and this prompter is only built when stdin is a TTY
    // (terminalUiSupported). So this is a guard, not a wait: an earlier
    // version retried here for 10s after a vendor login, which could never
    // change the answer -- it only delayed the same exit.
    if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    lifecycle('window.prompt.start');
    return new Promise((resolveQuestion, rejectQuestion) => {
      let value = this.queuedDraft ?? '';
      this.queuedDraft = undefined;
      this.signedInJustNow = false;
      let cursor = value.length;
      let selected = 0;
      let historyIndex = this.history.length;
      // Long pastes, held out of the draft as placeholders (held-pastes.ts)
      // and put back when it is sent.
      let held: HeldPaste[] = [];
      const draft = (): DraftWithPastes => ({ value, cursor, held });
      const apply = (next: DraftWithPastes): void => { value = next.value; cursor = next.cursor; held = [...next.held]; };
      // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
      // footer band a fixed height is what stops the conversation area above it from
      // reflowing (and the cursor from jumping) as the number of matches narrows.
      const paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
      // Every match, not the first eight: paint() windows a longer list, so
      // the selection can reach all of them.
      const matches = () => commandPaletteMatches(value, commands);
      // The row that runs is the row that is highlighted. When what was typed
      // names a command outright (`/new`), that command's row starts
      // highlighted, wherever its group ranks it -- so Enter and Right Arrow,
      // which both run the highlighted row, run what was typed.
      const highlightFor = (text: string): number => {
        const typed = exactPaletteCommand(text, commands)?.toLowerCase();
        if (!typed) return 0;
        const rows = commandPaletteMatches(text, commands);
        const at = rows.findIndex((row) => row.value.toLowerCase() === typed || row.aliases?.some((alias) => alias.toLowerCase() === typed));
        return Math.max(0, at);
      };
      // Running a command clears the palette and the typed command first, so
      // whatever it opens next -- a picker, a sign-in -- never has the
      // finished list and its `/command` left on screen around it.
      const runCommand = (line: string): void => {
        value = '';
        cursor = 0;
        selected = 0;
        draw();
        finish(line);
      };
      let stopInput: () => void = () => {};
      const draw = (): void => {
        const options = commandPaletteMatches(value, commands);
        if (selected >= options.length) selected = 0;
        if (options.length) {
          // After a space the palette is that command's own values to choose
          // from, or -- for a free-text argument -- just its hint.
          const hint = options[0]?.completes ? '↑↓ choose · Tab fill in · Enter apply · Esc clear'
            : value.includes(' ') ? 'Enter run · Esc clear' : undefined;
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity, ...(hint ? { hint } : {}) });
          this.paletteActive = true;
          return;
        }
        this.paletteActive = false;
        // Palette closure and ordinary typing are both complete frames, so
        // the transcript immediately reclaims any previously reserved rows.
        // A secret (an API key typed into a sign-in) is drawn as dots.
        this.paint(settings?.secret ? '•'.repeat(value.length) : value, [], 0, prompt, cursor);
      };
      let finished = false;
      /** The prompt is over, however it ended: the keyboard and the read
       * modes are given back, once. False when it had already ended. */
      const release = (): boolean => {
        if (finished) return false;
        finished = true;
        this.paletteActive = false;
        stopInput();
        output.write(`${popReadModes()}\u001b[?25h`);
        this.cursorShown = true;
        this.resumeInput = undefined;
        return true;
      };
      const finish = (answer: string): void => {
        if (!release()) return;
        lifecycle('window.prompt.end', { how: !answer ? 'empty' : answer.startsWith('/') ? `command ${answer.split(/\s/, 1)[0]}` : 'message' });
        this.clearTransientNotice();
        if (answer) this.panelState = undefined;
        // A line sent is done with the mention it was looking at.
        if (answer) this.mentionFocus = undefined;
        // The submitted line is the conversation's now. Leaving it in the
        // composer made the next idle check look like a draft still in progress.
        this.composer = { ...this.composer, text: '' };
        if (answer && !settings?.secret && !answer.startsWith('/') && this.history[this.history.length - 1] !== answer) this.history.push(answer);
        resolveQuestion(answer);
      };
      // Opt-in, not a default: this same question() drives the persistent
      // chat composer too, where Esc doing nothing is the existing,
      // intentional behavior (there's nothing to "cancel" mid-draft the way
      // there is for a one-off prompt). Callers that need real cancel
      // semantics -- like the API-key env-var-name prompt, previously
      // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
      // { cancellable: true } and get a real rejection to catch, instead of
      // an empty string indistinguishable from "accepted the default".
      const cancel = (): void => {
        if (!release()) return;
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      // Something other than the keyboard needs the screen: a turn this
      // window did not start is running (worker/turn-bridge.ts). The draft is
      // kept for the next prompt, and the caller is told why it ended.
      const interrupt = (): void => {
        if (!release()) return;
        // Kept whole: a placeholder in the next prompt's draft would have
        // lost the paste it stood for.
        const kept = expandPastes(value, held);
        if (kept) this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${kept}` : kept;
        rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
      };
      if (settings?.signal?.aborted) {
        this.queuedDraft = value || undefined;
        rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
        return;
      }
      settings?.signal?.addEventListener('abort', interrupt, { once: true });
      const handleKey = (key: string): void => {
        if (key === '\u000c') {
          this.requestRedraw('repair');
          this.forgetScreenPosition();
          return draw();
        }
        const matched = matches();
        // `options` drives selection keys. While an argument is being typed the
        // palette is only a hint -- unless it is listing the argument's own
        // values, which are chosen exactly like commands are.
        const completing = Boolean(matched[0]?.completes);
        const options = value.includes(' ') && !completing ? [] : matched;
        const pasted = pastedText(key);
        if (pasted !== undefined) {
          // Pasted newlines are content, not Enter. Splitting on them is what
          // turned one pasted block into a queue of separate messages. A long
          // one is held as `[Pasted text #1 +40 lines]`.
          const next = insertPaste(draft(), pasted, this.pasteCount + 1);
          if (next.held.length > held.length) this.pasteCount += 1;
          apply(next);
          selected = 0;
          return draw();
        }
        // Ctrl+O: the held pastes back in the draft as text, to read or edit.
        if (key === '\u000f') {
          if (!held.length) return;
          cursor = expandPastes(value.slice(0, cursor), held).length;
          value = expandPastes(value, held);
          held = [];
          return draw();
        }
        if (key === '\u001a') return this.suspendToShell();
        // Esc on an empty composer, no panel open, stops a turn parked for
        // the quota reset.
        if (key === '\u001b' && !value && !this.panelState && this.idleEscape) { const stop = this.idleEscape; this.idleEscape = undefined; stop(); return; }
        if (!value && !matched.length && this.panelKey(key)) return draw();
        if (key === '\u0003') {
          // Ctrl+C clears a draft first. Leaving takes a second press, because
          // the same key also interrupts a turn and is pressed by reflex.
          if (value) { value = ''; cursor = 0; held = []; selected = 0; historyIndex = this.history.length; return draw(); }
          if (Date.now() - exitArmedAt <= EXIT_CONFIRM_MS) return finish('/exit');
          exitArmedAt = Date.now();
          this.showTransientNotice('Press Ctrl+C again to exit', EXIT_CONFIRM_MS, draw);
          return draw();
        }
        if (exitArmedAt) { exitArmedAt = 0; this.clearTransientNotice(); }
        // Ctrl+D is end-of-input only on an empty draft; otherwise it deletes
        // forward like every other line editor.
        if (key === '\u0004' && !value) return finish('/exit');
        if (key === '\u001b' && settings?.cancellable) return cancel();
        if (key === '\u001b' && matched.length) {
          value = '';
          cursor = 0;
          selected = 0;
          return draw();
        }
        if (key === '\r') {
          const continued = options.length ? undefined : backslashNewline(value, cursor);
          if (continued) { value = continued.value; cursor = continued.cursor; return draw(); }
          // A value from the command's own list: what was typed wins when it
          // IS a value, otherwise the highlighted one.
          if (completing) return runCommand(completedCommandLine(value, commands, selected));
          // The highlighted command, bare. One that takes a value (model,
          // effort, permissions, account, resume) opens its own picker, titled
          // and starting on the current value; the values are listed here
          // only once one is being typed (`/model op`).
          if (options.length && value.startsWith('/') && !value.includes(' ')) return runCommand(options[selected].value);
          if (value.startsWith('/')) return runCommand(expandPastes(value, held));
          return finish(expandPastes(value, held));
        }
        if (key === '\t' && options.length) {
          // A value fills in as it is, ready to run or to keep editing; a
          // command that takes an argument completes ready for it.
          value = completing ? options[selected].value
            : `${options[selected].value}${options[selected].argHint || options[selected].argValues ? ' ' : ''}`;
          cursor = value.length;
          selected = 0;
          return draw();
        }
        // Up/Down navigate palette options; otherwise they move through a
        // multi-line draft and fall through to input history from its first
        // and last line. (Wheel/touch scrolling belongs to the terminal and
        // never arrives as these keys.) Ctrl+P/Ctrl+N always mean history.
        const historyStep = (direction: -1 | 1): void => {
          if (direction < 0 && historyIndex > 0) historyIndex -= 1;
          else if (direction > 0) historyIndex = Math.min(this.history.length, historyIndex + 1);
          else return;
          value = this.history[historyIndex] ?? '';
          cursor = value.length;
        };
        if (key === '\u001b[A' || key === '\u001b[B') {
          const direction = key === '\u001b[A' ? -1 : 1;
          if (options.length) { selected = (selected + direction + options.length) % options.length; return draw(); }
          // An empty composer means the conversation is what is being looked
          // at, so the arrows read it. Recorded from a real phone client: a
          // swipe arrives as arrow keys and nothing else -- no mouse report in
          // any encoding, and no page keys on the keyboard -- so on that
          // client this is the only way back through the conversation at all.
          // History keeps Ctrl+P and Ctrl+N, which is where it always was as
          // well, and the arrows still move through a draft once there is one.
          if (!value) {
            if (this.scrollTranscript(direction === -1 ? SWIPE_ROWS : -SWIPE_ROWS)) return;
            if (direction === 1 && this.noteReadingDirection()) return;
          }
          const moved = composerVerticalMove(value, cursor, direction);
          if (moved !== undefined) cursor = moved;
          else historyStep(direction);
          return draw();
        }
        if (key === '\u0010' && !options.length) { historyStep(-1); return draw(); }
        if (key === '\u000e' && !options.length) { historyStep(1); return draw(); }
        if (key === '\u001b[D') {
          // With nothing typed there is nothing for the arrow to move through,
          // so the chat composer spends it on its conversations: what is
          // running now, and below it what can be resumed.
          if (!value && settings?.leftArrowCommand) return finish(settings.leftArrowCommand);
          // Backing out of the command list clears it; inside an argument the
          // arrow edits, as it does in any line.
          if (options.length && !completing) { value = ''; cursor = 0; selected = 0; }
          else cursor = previousCharacterIndex(value, cursor);
          return draw();
        }
        if (key === '\u001b[C') {
          // Right Arrow is deliberately identical to Enter.
          if (completing && cursor >= value.length) return runCommand(completedCommandLine(value, commands, selected));
          if (options.length && value.startsWith('/') && !value.includes(' ')) return runCommand(options[selected].value);
          const paletteValue = composerRightArrowValue(value, options.length > 0, settings?.rightArrowPalette);
          if (paletteValue) {
            value = paletteValue;
            cursor = value.length;
            selected = 0;
            return draw();
          }
          cursor = nextCharacterIndex(value, cursor);
          return draw();
        }
        // Page keys read the conversation rather than edit the draft: the
        // alternate screen has no terminal scrollback behind it, so this is
        // the only way back through what was said. Shift+Up/Down does the
        // same a row at a time. Esc, which already clears a draft, also
        // returns to the live end.
        if (this.handleScrollKey(key)) return;
        // Escape returns to the live end here; in the waiting band it keeps
        // meaning interrupt, and a new turn rejoins on its own.
        if (key === '\u001b' && this.scrolledBack) { this.scrollTranscript(-Number.MAX_SAFE_INTEGER); return; }
        // A placeholder is deleted whole, its paste with it.
        const removed = key === '\u007f' || key === '\b' ? removePlaceholderAt(draft(), 'back')
          : key === '\u001b[3~' || key === '\u0004' ? removePlaceholderAt(draft(), 'forward') : undefined;
        if (removed) { apply(removed); selected = highlightFor(value); return draw(); }
        // Everything else is text editing, shared with the waiting composer.
        const edited = editComposer(value, cursor, key);
        if (!edited.changed) return;
        if (edited.value !== value) selected = highlightFor(edited.value);
        value = edited.value;
        cursor = edited.cursor;
        // An edit that broke a placeholder drops its paste.
        held = keptPastes(value, held);
        draw();
      };
      let exitArmedAt = 0;
      const listen = (): void => {
        stopInput = takeTerminalKeys((key) => { if (!finished) handleKey(key); });
        output.write(enterInputModes());
      };
      this.resumeInput = () => { stopInput(); if (!finished) listen(); };
      // Typed ahead under a sign-in: before anything the terminal sends
      // next (listen() hands that on, on a later tick than this one). What
      // follows an Enter that sent this prompt is the next prompt's draft.
      const ahead = this.typedAhead.splice(0);
      if (ahead.length) {
        process.nextTick(() => {
          for (const [index, key] of ahead.entries()) {
            if (!finished) { handleKey(key); continue; }
            const rest = ahead.slice(index).filter((item) => !item.startsWith('\u001b') && item.charCodeAt(0) >= 0x20 && item !== '\u007f').join('');
            if (rest) this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}${rest}` : rest;
            break;
          }
        });
      }
      listen();
      draw();
    });
  }

  /** Provider/model/effort pickers share the same frame and palette layout as
   * slash commands, so the conversation stays visible above them.
   *
   * Type-to-filter: letters, digits and space narrow the list live by
   * substring match against label and detail (title, provider, status), and
   * the arrows move through what is visible -- so a long list (/resume, with
   * every discovered vendor chat) stays findable, and no letter is a key
   * alias that would collide with a filter query. */
  select<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: PickerSettings<T>,
  ): Promise<T | undefined> {
    lifecycle('window.picker.open', { title: title.slice(0, 80), options: options.length });
    return runOptionPicker<T>(this.pickerHost(), title, options, onAction, settings)
      .finally(() => lifecycle('window.picker.close', { title: title.slice(0, 80) }));
  }

  board(settings: ConversationBoardSettings): Promise<BoardResult | undefined> {
    lifecycle('window.board.open');
    return runConversationBoard(this.pickerHost(), settings).finally(() => lifecycle('window.board.close'));
  }

  private pickerHost(): OptionPickerHost {
    return {
      paint: (composer, pickerOptions, selected, prompt, cursor, palette) =>
        this.paint(composer, pickerOptions, selected, prompt, cursor, palette),
      clearFrame: () => this.clearInteractiveFrame(),
      // A closed picker is not the frame to come back to: resume() and any
      // repaint after it used to draw the finished list again (with the
      // palette's hint under it) before the next frame replaced it.
      setSelecting: (selecting) => {
        this.selecting = selecting;
        if (!selecting) this.composer = EMPTY_COMPOSER;
      },
      select: (subTitle, subOptions, subAction, subSettings) => this.select(subTitle, subOptions, subAction, subSettings),
    };
  }

  /** Nothing is using this terminal: no turn, no picker, no palette, and no
   * typed or queued draft. A newer build may replace the process here. */
  idleForBuildReplace(): boolean {
    return !this.closed && !this.suspended && !this.selecting && !this.paletteActive
      && !this.turn && !this.composer.text && !this.queuedDraft;
  }

  close(): void {
    if (this.closed) return;
    lifecycle('window.close');
    this.closed = true;
    this.pendingLive = undefined;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.stopWaiting(false);
    this.clearTransientNotice();
    if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
    this.resizePaintTimer = undefined;
    this.stopScrollBatch?.();
    this.stopScrollBatch = undefined;
    this.stopDrainBatch?.();
    this.stopDrainBatch = undefined;
    if (this.scrollDrainTimer) clearTimeout(this.scrollDrainTimer);
    this.scrollDrainTimer = undefined;
    this.pendingScroll = 0;

    input.off('data', KEEP_STDIN_FLOWING);
    this.stopFocusReports?.();
    process.off('SIGWINCH', this.onResize);
    process.off('SIGCONT', this.onContinue);
    process.off('exit', restoreTerminal);
    setTerminalRawMode(false);
    input.pause();
    // The alternate screen is handed back and the shell's own screen returns
    // untouched. The conversation is on disk -- `/resume` reopens it.
    output.write(
      `${popReadModes()}`
      + terminalTeardown(terminalModes.alternateScreen)
      + signalsTeardown(),
    );
    terminalModes.alternateScreen = false;
    terminalModes.painted = false;
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  async suspend(): Promise<void> {
    lifecycle('window.suspend');
    this.suspended = true;
    this.pendingLive = undefined;
    this.forgetScreenPosition();
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    setTerminalRawMode(false);
    input.pause();
    // Remove the composer and footer before handing over, so the vendor's
    // output continues directly under the conversation instead of being typed
    // across this UI's status rows. Handed over once the modes are written --
    // where a TTY write is asynchronous (Windows) the child must not start
    // ahead of them -- rather than after a guessed 50ms.
    await new Promise<void>((resolveWritten) => { output.write(sessionModesOff(false), () => resolveWritten()); });
  }

  resume(): void {
    if (this.closed) return;
    lifecycle('window.resume');
    this.retakeScreen();
    if (input.isTTY) input.resume();
    this.repaint({ keepPalette: false });
  }
}
