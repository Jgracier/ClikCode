/** The interactive terminal, drawn on the alternate screen: the conversation
 * as a transcript this UI keeps and scrolls itself, and below it one live
 * region holding the changing response, controls and composer. Every row is
 * written at an address, and a frame writes only the rows that changed. */

import chalk from 'chalk';
import { lifecycle, setLifecycleSession } from '../runtime/lifecycle-log.js';
import type { LoginLink, SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../gateway/login/url.js';
import { pastedText } from './keys.js';
import { backslashNewline, composerVerticalMove, editWaitingComposer } from './composer-edit.js';
import { commandPaletteMatches, completedCommandLine, composerRightArrowValue, exactPaletteCommand, type PaletteEntry } from './command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { noticeLines } from './render/wrap.js';
import { composerLayout } from './render/composer-layout.js';
import { closeOpenHyperlink } from './render/hyperlinks.js';
import { createStreamingBlockParser } from './render/markdown.js';
import { sanitizeTerminalText } from './render/text.js';
import { nextCharacterIndex, previousCharacterIndex, terminalCellWidth, visibleSlice, visibleTail } from './render/width.js';
import { ENTER_ALTERNATE_SCREEN, installTerminalRestoreSignals, REEXEC_TERMINAL_ENV, restoreTerminal, terminalModes, terminalPrepare } from './restore.js';
import type { FocusState } from './terminal-signals.js';
import { stripRepeatedTitles } from '../session/title.js';
import { sessionTranscriptMessages, settledTranscriptMessages } from '../turn/checkpoint.js';
import { readTurnActivities } from '../turn/turn-activities.js';
import { readTurnMarks } from '../turn/turn-marks.js';
import { TurnTranscript, type SettlingTool } from '../turn/transcript.js';
import type { HarnessPrompter, JournalState, MessageBlock, PickerOption, PickerSettings, ToolCategory } from '../harness/prompter.js';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { ActivityEntry, collapseToolRuns, commonPrefixLength, rebaseActivityOffsets, settleDecisionEntry, transientAssistantRequired, upsertActivityEvent } from './render/activity-log.js';
import { toolUses, type OpenTool, liveWaitKind, waitingSpinnerGlyph, type Thought } from '../harness/protocol/activity-view.js';
import { outputPreviewRows, renderActivityLine } from '../harness/protocol/activity-line.js';
import { logProcessWarnings } from './warnings.js';
import { backgroundTerminalsLabel, reasoningBody, tensedLabel } from '../harness/protocol/turn-flow.js';
import { turnEndLine } from './render/turn-end-line.js';
import { accountSwitchLine } from '../turn/failover.js';
import { expandPastes, insertPaste, keptPastes, removePlaceholderAt, type DraftWithPastes, type HeldPaste } from './render/held-pastes.js';
import { ExploreGrouping, mergedExploreLines, mergedExploreSummaryLine, type GroupRow, type TurnGroup } from './render/explore-groups.js';
import { TOOL_CATEGORY_STYLE } from '../harness/protocol/tool-category-style.js';
import { ApprovalRequest, approvalBlockRows } from './render/approval-block.js';
import { APPROVAL_GUARD_MS } from './render/approval-keys.js';
import { questionBlockRows } from './render/question-block.js';
import { APPROVAL_MIN_ROWS, fitFooterForApproval, frameRowBudget } from './render/frame-budget.js';
import { fitHint, paletteRows as paletteBandRows, panelRows as panelBandRows } from './render/footer-rows.js';
import { runOptionPicker, type OptionPickerHost, type PaletteLayout } from './option-picker.js';
import { runConversationBoard, type BoardResult, type ConversationBoardSettings } from './conversation-board.js';
import { EmittedTranscript } from './render/emitted-transcript.js';
import { reseedStartIndex } from './render/reseed-window.js';
import { LiveChildren } from './render/child-rows.js';
import { enterAgainSends, hasDurableSteer, liveTurnSpan, STEER_WORDS, steerTranscriptRows, type SteerRow } from './render/steer-rows.js';
import { pendingPromptText } from './render/pending-prompt.js';
import { markTurn, turnMarkOpen } from '../runtime/turn-latency.js';
import { highlightWords, type MentionFocus } from './render/search-focus.js';
import { highlightSelectionAt, scrollShift, shiftedRow, type Selection } from './render/selection.js';
import { messageRows as cachedMessageRows, noticeRows as clikCodeNoticeRows, renderMessageBlocks } from './render/message-blocks.js';
import { isClikCodeNotice } from '../session/clikcode-notice.js';
import { reducedMotion } from './capabilities.js';
import { logCursorEvent } from './cursor-log.js';
import { KEEP_STDIN_FLOWING, onTerminalFocus, takeTerminalKeys } from './input-decoder.js';
import { SWIPE_ROWS, enterInputModes, popReadModes, redrawPreamble, sessionModesOn, takeQueuedModes, type Redraw } from './modes.js';
import { PlanEntry, planBlockRows } from './render/plan-block.js';
import { callRow, underCallRow } from './render/tool-rows.js';
import { callDecision, savedTurnRanks, turnMarkLines } from './render/turn-mark-rows.js';
import { composerUsageLabel, liveConversationLines, paintTitleRule, paintUsageRule, runningChatLine } from './render/waiting.js';
import { keyHint, keyHintFor } from '../harness/protocol/wording.js';
import { EXIT_CONFIRM_MS, ALTERNATE_TRANSCRIPT_ROWS, LIVE_OUTPUT_LINES, type ComposerFrame, EMPTY_COMPOSER, type WaitingTurn } from './prompter/state.js';
import { retakeScreen, retakeTerminalSignals, takeTerminalTitle, terminalSignals, notifyIfAway, suspendToShell, onContinue, close, suspend, resume } from './prompter/terminal-lifecycle.js';
import { scrollTranscript, drainScroll, queueScroll, drainAtBatchEnd, scheduleScrollPaint, handleScrollKey, handleSelection, lineAtScreenRow, selectionText, followSelectionEdge, stepSelectionScroll, stopSelectionScroll, redrawSelection, noteReadingDirection, forgetScreenPosition } from './prompter/scroll-selection.js';
import { showMention, mentionKey, endMention, jumpToMention } from './prompter/mention.js';
import { notice, showTransientNotice, clearTransientNotice, panel, panelKey } from './prompter/notices.js';
import { answerApproval, restoreTellingDraft, approval, withdrawApproval, askQuestions, questionKey, presentNextApproval, settleApprovals } from './prompter/approvals.js';
import { activity, setPlan, settlePlan, activityEvent, settleThought, markDrawn, joinMark, joinThought, settleDecision, ofThisTurn, settleSavedStops } from './prompter/activity-state.js';
import { editTurnDraft, waitingUserMessages, enterAgainReady, turnHasAnswer, takeBackWaiting, submitWaiting, waitingLabel, updateWaitingLabel, joinedWaiting, startWaiting, turnStarting, toolStatus, turnWaits, waitingOnUser, scheduleWaitingTick, stepTokens, setTurnUsage, setBackgroundWork, pauseClock, resumeClock, flushWaitingSubmissions, leaveTurn, turnStopped, onWaitingEnded, stopWaiting, vendorAnswered, phase } from './prompter/waiting-turn.js';
import { statusText, waitingLine, escStops, updateWaiting, schedulePaint, paintWaiting, repaint } from './prompter/waiting-band.js';
import { onWaitingKey } from './prompter/waiting-keys.js';
import { viewportRows, onResize, repaintAfterResize, rewrapIfWidthChanged, clearTranscript } from './prompter/viewport.js';


export class TerminalHarnessPrompter implements HarnessPrompter {
  closed = false;
  history: string[] = [];
  currentSession?: HarnessSession;
  currentNotice?: string;
  /** The composer as the last paint drew it, for repaint() to draw again. */
  composer: ComposerFrame = EMPTY_COMPOSER;
  /** The turn (or other wait) in flight: see WaitingTurn. */
  turn?: WaitingTurn;
  waitingFrame = 0;
  /** Background terminals the vendor says are running (the footer indicator). */
  backgroundTerminals = 0;
  /** Orders answer text against call starts for answerWriting: a counter, so
   * two events in one millisecond keep their order. */
  statusOrder = 0;
  /** Whether the pending tick is the spinner's (true) or the clock's. */
  waitingTickFast = false;
  activityEntries: ActivityEntry[] = [];
  /** A link sign-in's link and code, drawn above the waiting band while it
   * runs (linkWait). */
  signInLines: string[] = [];
  /** What the waiting composer is for while a sign-in asks for a code or a
   * key: Enter hands the draft here instead of to the turn. */
  signInInput?: { secret: boolean; optional?: boolean; alongside?: boolean; submit: (text: string) => void };
  /** A sign-in is up: the wait is on the user, in their browser, so the band
   * holds still as it does for an approval -- a ●, the clock stopped. */
  signingIn = false;
  /** collapseToolRuns over activityEntries, redone only when they change. */
  collapsedActivity?: { source: readonly ActivityEntry[]; entries: ActivityEntry[] };
  /** The steers this window drew into the running turn, by row id, kept past
   * the sources they were drawn from (the live submission is dropped when the
   * turn ends; the journal's copy is gone once the turn is saved). The saved
   * list then holds each as a user message of its own, and what was drawn
   * live is what decides which of those are copies (liveTurnSpan). */
  turnSteers = new Map<string, SteerRow>();
  /** The calls still open: the status line names the newest (toolStatus). */
  activeTools = new Map<string, OpenTool>();
  /** The calls inside running sub-agents, one live slot each
   * (render/child-rows.ts). Drawn nested under the agent, never retired. */
  readonly liveChildren = new LiveChildren();
  /** Which of this turn's reads and searches share a row (explore-groups.ts). */
  readonly exploreGrouping = new ExploreGrouping();
  liveResponse = '';
  responsePaintTimer?: NodeJS.Timeout;
  frameInFlight = false;
  /** Why the next frame that draws rows is drawn, when it is not routine:
   * after a resize, or a repair (Ctrl+L). See redrawPreamble. */
  pendingRedraw: Redraw | undefined;
  queuedDraft?: string;
  /** A message typed and sent (Enter) under a sign-in's own wait, and any
   * keys after it: typed into the prompt that opens next, as if typed there,
   * so it is sent -- the wait has no turn to send it to. */
  typedAhead: string[] = [];
  /** A sign-in's wait just ended: what was typed under it goes on into the
   * turn that starts next (startWaiting). */
  signedInJustNow = false;
  /** The turn this window stepped out of (leaveTurn), still running in its
   * worker. What it already wrote to scrollback is remembered here, nothing
   * more of it is drawn while away, and following the same turn again
   * carries on from where scrollback stops. */
  steppedOut?: { sessionId: string; prompt?: string; anchor: number };
  /** The highest index of the running turn's activities already shown (see
   * activityEvent's `live`), so replaying them on a (re)join adds only the
   * ones this window has not seen. */
  liveActivitiesShown = -1;
  /** What the last render said about `currentSession`'s journal. */
  journal: JournalState = { running: true };
  /** `id` arrives with the answer to the submission, and is the same id its
   * durable copy (a queued turn, a recorded steer) is stored under. */
  waitingSubmissions: Array<{ localId: number; id?: string; text: string; responseOffset: number; sequence: number; ack?: { sequence: number; responseOffset: number }; state: 'sending' | 'queued' | 'steered' | 'error' | 'command'; unsteered?: boolean }> = [];
  waitingSubmissionId = 0;
  timelineSequence = 0;
  readonly waitingSubmissionWrites = new Set<Promise<void>>();
  suspended = false;
  readonly reducedMotion = reducedMotion();
  activityAnchor = 0;
  /** Rows retired since the last frame reached the terminal, and the live
   * region that frame will draw below them. */
  pendingFinished: string[] = [];
  pendingLive?: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean };
  /** The last row retired, so a blank separator is never doubled across the
   * boundary between one frame and the next. */
  lastFinishedRow?: string;
  /** The row before it, so the guard that separates messages can tell one
   * empty row from two across a frame boundary. */
  secondLastFinishedRow?: string;
  readonly turnTranscript = new TurnTranscript();
  /** What is already in the transcript. See emitted-transcript.ts: a retired
   *  row is never rewritten in place, so the rules live in one place. */
  readonly emitted = new EmittedTranscript();
  /** The width the transcript's rows were wrapped at. A resize to another
   * width wraps the whole conversation again (see rewrapTranscript). */
  transcriptColumns = output.columns || 0;
  usageLabel?: string;
  usageResetLabel?: string;
  selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever composer.options happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  paletteActive = false;
  /** A mouse selection in progress, in conversation lines, not screen rows
   * (see lineAtRow): a drag that scrolls the view keeps what it selected, and
   * one longer than the screen copies whole. */
  selection?: Selection;
  /** While a drag rests on the top or bottom edge, the view keeps scrolling
   * that way, a line at a time, extending the selection -- the way every
   * terminal's own selection does. */
  selectionScroll?: { timer: NodeJS.Timeout; direction: 1 | -1; col: number };
  /** Rows dropped from the front of alternateTranscript, so a line's number
   * stays the same when older rows are trimmed. */
  alternateTrimmed = 0;
  /** Each message's first line in the transcript, numbered as
   * alternateTrimmed + index, so it holds while rows are trimmed. */
  readonly messageLines = new Map<number, number>();
  /** /search: the mention being looked at in the conversation shown, its
   * words highlighted; `jumped` once the view has been moved to it. */
  mentionFocus?: MentionFocus & { sessionId: string; jumped: boolean };
  /** The live rows below the transcript in the last frame: the text a
   * selection copies from them. */
  frameLayout = { live: [] as string[] };
  /** What the composer's slash palette offers, remembered from the last
   * question() so a turn in flight can offer the same commands. A turn does
   * not change which commands exist; each is re-checked when it runs. */
  paletteCommands: readonly PaletteEntry[] = [];
  /** The prompt this client submitted, held from Enter until the turn ends.
   * See render/pending-prompt.ts: the snapshot alone cannot draw it for the
   * whole turn, so the client keeps its own copy of what it sent. */
  submittedPrompt?: string;
  pendingApproval?: ApprovalRequest & { shownAt: number; needsFocus: boolean; focused: boolean };
  approvalGuardTimer?: NodeJS.Timeout;
  /** A short-lived hint (the Ctrl+C exit warning) that takes the notice row. */
  transientNotice?: string;
  transientNoticeTimer?: NodeJS.Timeout;
  thought?: Thought;
  /** When the thought on screen began, and how much of the answer had
   * streamed: it settles there as "Thought for 3s" (settleThought). */
  thoughtStart?: { at: number; offset: number; markId?: string };
  /** `<anchor>:<mark id>` of every worker mark already on screen (markDrawn). */
  readonly drawnMarks = new Set<string>();
  panelState?: { title: string; lines: string[]; offset: number; page: number; total: number };
  planEntries: readonly PlanEntry[] = [];
  /** The length of the answer when this turn's plan first appeared (settlePlan). */
  planStart: number | undefined;
  streamingBlocks = createStreamingBlockParser();
  /** Re-installs the key listener and raw mode after Ctrl+Z / `fg`. */
  resumeInput?: () => void;
  /** Providers fan out parallel tool calls, so a second request can arrive
   * while the first is still on screen. Queueing asks them one at a time;
   * resolving the extras false meant silently denying a tool the user was
   * never shown. */
  approvalQueue: ApprovalRequest[] = [];
  /** Approvals answered since the last time none was waiting: this one is
   * number answered + 1 of answered + 1 + queued. */
  approvalsAnswered = 0;
  /** Whether the terminal says it is being looked at (terminal-signals.ts). */
  focus: FocusState = { since: 0 };
  stopFocusReports?: () => void;
  /** The window title last written, so an unchanged one is not written. */
  terminalTitle?: string;
  /** Long pastes held as placeholders so far, for the next one's number. */
  pasteCount = 0;
  /** "Tell it instead" is being typed; the draft the composer held before. */
  tellingInstead?: { draft: string; cursor: number };
  approvalRestoreLabel?: string;
  /** The last label a phase report set ("switching to …", "retrying"): what
   * the turn was doing before the vendor answered. The vendor's first output
   * after it ends it; labels this window sets itself (stopping, waiting for
   * approval) are not phases and stay. */
  reportedPhase?: string;
  readonly onWaitingKey = (...args: Parameters<typeof onWaitingKey>): ReturnType<typeof onWaitingKey> => onWaitingKey.apply(this, args);

  editTurnDraft(...args: Parameters<typeof editTurnDraft>): ReturnType<typeof editTurnDraft> { return editTurnDraft.apply(this, args); }

  waitingUserMessages(...args: Parameters<typeof waitingUserMessages>): ReturnType<typeof waitingUserMessages> { return waitingUserMessages.apply(this, args); }

  enterAgainReady(...args: Parameters<typeof enterAgainReady>): ReturnType<typeof enterAgainReady> { return enterAgainReady.apply(this, args); }

  turnHasAnswer(...args: Parameters<typeof turnHasAnswer>): ReturnType<typeof turnHasAnswer> { return turnHasAnswer.apply(this, args); }

  takeBackWaiting(...args: Parameters<typeof takeBackWaiting>): ReturnType<typeof takeBackWaiting> { return takeBackWaiting.apply(this, args); }

  submitWaiting(...args: Parameters<typeof submitWaiting>): ReturnType<typeof submitWaiting> { return submitWaiting.apply(this, args); }

  answerApproval(...args: Parameters<typeof answerApproval>): ReturnType<typeof answerApproval> { return answerApproval.apply(this, args); }

  settleDecision(...args: Parameters<typeof settleDecision>): ReturnType<typeof settleDecision> { return settleDecision.apply(this, args); }

  restoreTellingDraft(...args: Parameters<typeof restoreTellingDraft>): ReturnType<typeof restoreTellingDraft> { return restoreTellingDraft.apply(this, args); }
  readonly onResize = (...args: Parameters<typeof onResize>): ReturnType<typeof onResize> => onResize.apply(this, args);

  viewportRows(...args: Parameters<typeof viewportRows>): ReturnType<typeof viewportRows> { return viewportRows.apply(this, args); }

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
  resizePaintTimer?: NodeJS.Timeout;
  /** The frame being drawn is a resize's immediate one: it leaves the
   * pending resize preamble to the settled frame. */
  provisionalFrame = false;
  repaintAfterResize(...args: Parameters<typeof repaintAfterResize>): ReturnType<typeof repaintAfterResize> { return repaintAfterResize.apply(this, args); }

  rewrapIfWidthChanged(...args: Parameters<typeof rewrapIfWidthChanged>): ReturnType<typeof rewrapIfWidthChanged> { return rewrapIfWidthChanged.apply(this, args); }

  clearTranscript(...args: Parameters<typeof clearTranscript>): ReturnType<typeof clearTranscript> { return clearTranscript.apply(this, args); }

  /** Rows retired out of the viewport, kept so the conversation above the
   * live region is still there to scroll back to on the alternate screen. */
  readonly alternateTranscript: string[] = [];
  /** Exactly the rows the last alternate-screen frame left on screen, so the
   * next one writes only what differs. */
  alternatePrevious: string[] = [];
  /** How many rows above the live region the viewport is held back by. Zero
   * follows the conversation, which is what a transcript does until someone
   * asks to look at what went past. Drawing on the alternate screen took the
   * terminal's own scrollback away; this is what replaces it. */
  alternateScrollback = 0;
  /** Rows the last frame gave the transcript above the live region. The
   * scroll offset is bounded by it, and it changes with the screen. */
  alternateAbove = 0;
  /** Whether the last frame left the cursor shown (undefined: not known), and
   * where it parked it, so a frame that changes neither writes nothing. */
  cursorShown: boolean | undefined;
  lastPark = '';

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
    // A held prompt let go before its turn (its sign-in did not sign in): a
    // line written after it now goes after the conversation, or it would sit
    // past the end and never be drawn.
    if (prompt === undefined && this.submittedPrompt !== undefined && !this.turn && this.currentSession) {
      const end = this.transcriptMessages(this.currentSession).length;
      this.activityEntries = this.activityEntries.map((entry) => (entry.anchor > end ? { ...entry, anchor: end } : entry));
    }
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
  transcriptMessages(session: HarnessSession): NonNullable<HarnessSession['messages']> {
    return this.journal.running ? settledTranscriptMessages(session, this.journal.prompt) : sessionTranscriptMessages(session);
  }

  /** Where activity outside a turn goes: after the conversation as drawn --
   * a prompt held for a turn not started yet (a sign-in before it) included,
   * or its outcome line lands at a place already written and is never drawn. */
  restingAnchor(): number {
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
      this.planStart = undefined;
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
      this.settleSavedStops(session);
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
    // The thought led to this text: it settles where it was had.
    if (text) { this.settleThought(); this.vendorAnswered(); if (this.turn) { this.turn.activeAt = Date.now(); this.turn.writingAt = ++this.statusOrder; } }
    if (mode === 'replace') {
      // Only a turn in flight has tool rows whose place in the answer can
      // move. After it, a replacement (a snapshot's copy of the finished
      // answer) would rebase them against an empty stream -- to offset zero,
      // above the prose they followed.
      if (this.turn) {
        this.activityEntries = rebaseActivityOffsets(this.activityEntries, this.activityAnchor, this.liveResponse, text);
        this.liveChildren.rebase(commonPrefixLength(this.liveResponse, text));
      }
      this.liveResponse = text;
    } else this.liveResponse += text;
    this.schedulePaint();
  }

  activity(...args: Parameters<typeof activity>): ReturnType<typeof activity> { return activity.apply(this, args); }

  setPlan(...args: Parameters<typeof setPlan>): ReturnType<typeof setPlan> { return setPlan.apply(this, args); }

  settlePlan(...args: Parameters<typeof settlePlan>): ReturnType<typeof settlePlan> { return settlePlan.apply(this, args); }

  activityEvent(...args: Parameters<typeof activityEvent>): ReturnType<typeof activityEvent> { return activityEvent.apply(this, args); }

  settleThought(...args: Parameters<typeof settleThought>): ReturnType<typeof settleThought> { return settleThought.apply(this, args); }

  markDrawn(...args: Parameters<typeof markDrawn>): ReturnType<typeof markDrawn> { return markDrawn.apply(this, args); }

  joinMark(...args: Parameters<typeof joinMark>): ReturnType<typeof joinMark> { return joinMark.apply(this, args); }

  joinThought(...args: Parameters<typeof joinThought>): ReturnType<typeof joinThought> { return joinThought.apply(this, args); }

  panel(...args: Parameters<typeof panel>): ReturnType<typeof panel> { return panel.apply(this, args); }

  panelKey(...args: Parameters<typeof panelKey>): ReturnType<typeof panelKey> { return panelKey.apply(this, args); }

  waitingLabel(...args: Parameters<typeof waitingLabel>): ReturnType<typeof waitingLabel> { return waitingLabel.apply(this, args); }

  updateWaitingLabel(...args: Parameters<typeof updateWaitingLabel>): ReturnType<typeof updateWaitingLabel> { return updateWaitingLabel.apply(this, args); }

  joinedWaiting(...args: Parameters<typeof joinedWaiting>): ReturnType<typeof joinedWaiting> { return joinedWaiting.apply(this, args); }

  /** A vendor sign-in on screen (commands/account.ts withSignIn): its link
   * and code above the waiting band, a code or key typed into the waiting
   * composer, a choice in the picker, Esc cancelling it. Inside a running
   * turn (a sign-in the turn asked for) it borrows the turn's band and Esc
   * rather than starting a wait, which would reset the turn; stop() gives
   * them back. */
  signInScreen(name: string): SignInScreen {
    lifecycle('window.signin.start', { name });
    const controller = new AbortController();
    const label = `waiting for you to sign in to ${name}`;
    const cancel = (): void => controller.abort();
    const local = hasLocalDisplay();
    let opened = false;
    // The band: the link's lines, then the key offered beside it (alongside).
    let linkLines: string[] = [];
    let hint: string | undefined;
    const band = (): void => {
      this.signInLines = [...linkLines, ...(hint ? [hint] : [])];
      this.updateWaiting();
    };
    const show = (link: LoginLink): void => {
      if (local && !opened) { opened = true; openLoginUrl(link.url); }
      if (!local) output.write(loginUrlNotice(link.url).clipboard);
      linkLines = [
        `${chalk.bold(`Sign in to ${name}`)}${link.code ? ` · confirm the code ${chalk.bold(link.code)}` : ''}`,
        // Its own plain line: the band wraps a link rather than cutting it.
        link.url,
        chalk.dim(local ? 'opened in your browser' : 'link copied: open it on this device'),
      ];
      band();
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
    // Beside the vendor's sign-in (alongside): a line under its link, and
    // the composer left as it is -- the wait's label still says what it waits on.
    const ask = (prompt: string, secret: boolean, optional?: boolean, alongside?: boolean): Promise<string> => new Promise((resolve) => {
      const live = this.turn;
      hint = alongside ? chalk.dim(`${prompt} · paste it and press Enter`) : undefined;
      if (live && !alongside) {
        aside ??= { draft: live.draft, cursor: live.cursor };
        live.draft = ''; live.cursor = 0; live.label = `${prompt} · type it and press Enter`;
      }
      this.signInInput = {
        secret, optional, alongside,
        submit: (text) => {
          this.signInInput = undefined;
          hint = undefined;
          putBack();
          if (this.turn) this.turn.label = label;
          band();
          resolve(text);
        },
      };
      band();
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
        if (!turn && !controller.signal.aborted) { this.startWaiting(label, cancel); this.pauseClock(); }
      }
    };
    this.signingIn = true;
    if (turn) {
      turn.label = label;
      turn.cancel = cancel;
      turn.cancelled = false;
      this.pauseClock();
      this.scheduleWaitingTick();
      this.updateWaiting();
    } else { this.startWaiting(label, cancel); this.pauseClock(); }
    return {
      signal: controller.signal, show, ask, choose,
      stop: () => {
        this.signInLines = [];
        // An unanswered code is dropped; what was typed for the conversation
        // stays in the composer -- the turn's, or (outside one) the prompt's
        // that opens next, by stopWaiting.
        if (this.signInInput && !this.signInInput.alongside && this.turn) { this.turn.draft = ''; this.turn.cursor = 0; }
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
        // The user's time in the browser is not the turn's, nor its going quiet.
        this.resumeClock();
        turn.label = saved!.label;
        turn.cancel = saved!.cancel;
        turn.cancelled = saved!.cancelled;
        this.scheduleWaitingTick();
        this.updateWaiting();
      },
    };
  }

  startWaiting(...args: Parameters<typeof startWaiting>): ReturnType<typeof startWaiting> { return startWaiting.apply(this, args); }

  turnStarting(...args: Parameters<typeof turnStarting>): ReturnType<typeof turnStarting> { return turnStarting.apply(this, args); }

  toolStatus(...args: Parameters<typeof toolStatus>): ReturnType<typeof toolStatus> { return toolStatus.apply(this, args); }

  turnWaits(...args: Parameters<typeof turnWaits>): ReturnType<typeof turnWaits> { return turnWaits.apply(this, args); }

  waitingOnUser(...args: Parameters<typeof waitingOnUser>): ReturnType<typeof waitingOnUser> { return waitingOnUser.apply(this, args); }

  scheduleWaitingTick(...args: Parameters<typeof scheduleWaitingTick>): ReturnType<typeof scheduleWaitingTick> { return scheduleWaitingTick.apply(this, args); }

  stepTokens(...args: Parameters<typeof stepTokens>): ReturnType<typeof stepTokens> { return stepTokens.apply(this, args); }

  setTurnUsage(...args: Parameters<typeof setTurnUsage>): ReturnType<typeof setTurnUsage> { return setTurnUsage.apply(this, args); }

  setBackgroundWork(...args: Parameters<typeof setBackgroundWork>): ReturnType<typeof setBackgroundWork> { return setBackgroundWork.apply(this, args); }

  pauseClock(...args: Parameters<typeof pauseClock>): ReturnType<typeof pauseClock> { return pauseClock.apply(this, args); }

  resumeClock(...args: Parameters<typeof resumeClock>): ReturnType<typeof resumeClock> { return resumeClock.apply(this, args); }

  /** What the next prompt's composer opens with: a message that never
   * reached its turn, a cancelled one the worker hands back, or a `/`. */
  restoreDraft(value: string): void { this.queuedDraft = value; }
  flushWaitingSubmissions(...args: Parameters<typeof flushWaitingSubmissions>): ReturnType<typeof flushWaitingSubmissions> { return flushWaitingSubmissions.apply(this, args); }

  leaveTurn(...args: Parameters<typeof leaveTurn>): ReturnType<typeof leaveTurn> { return leaveTurn.apply(this, args); }

  turnStopped(...args: Parameters<typeof turnStopped>): ReturnType<typeof turnStopped> { return turnStopped.apply(this, args); }

  onWaitingEnded(...args: Parameters<typeof onWaitingEnded>): ReturnType<typeof onWaitingEnded> { return onWaitingEnded.apply(this, args); }

  stopWaiting(...args: Parameters<typeof stopWaiting>): ReturnType<typeof stopWaiting> { return stopWaiting.apply(this, args); }

  retakeScreen(...args: Parameters<typeof retakeScreen>): ReturnType<typeof retakeScreen> { return retakeScreen.apply(this, args); }

  retakeTerminalSignals(...args: Parameters<typeof retakeTerminalSignals>): ReturnType<typeof retakeTerminalSignals> { return retakeTerminalSignals.apply(this, args); }

  /** A resize outranks a repair: it does all a repair does, and more. */
  requestRedraw(redraw: Redraw): void {
    if (this.pendingRedraw !== 'resize') this.pendingRedraw = redraw;
  }

  takeTerminalTitle(...args: Parameters<typeof takeTerminalTitle>): ReturnType<typeof takeTerminalTitle> { return takeTerminalTitle.apply(this, args); }

  terminalSignals(...args: Parameters<typeof terminalSignals>): ReturnType<typeof terminalSignals> { return terminalSignals.apply(this, args); }
  /** Title and progress sequences owed to the terminal, written inside the
   * next synchronized frame rather than on their own beside it. */
  pendingSignals = '';

  notifyIfAway(...args: Parameters<typeof notifyIfAway>): ReturnType<typeof notifyIfAway> { return notifyIfAway.apply(this, args); }

  ofThisTurn(...args: Parameters<typeof ofThisTurn>): ReturnType<typeof ofThisTurn> { return ofThisTurn.apply(this, args); }

  settleSavedStops(...args: Parameters<typeof settleSavedStops>): ReturnType<typeof settleSavedStops> { return settleSavedStops.apply(this, args); }

  vendorAnswered(...args: Parameters<typeof vendorAnswered>): ReturnType<typeof vendorAnswered> { return vendorAnswered.apply(this, args); }

  phase(...args: Parameters<typeof phase>): ReturnType<typeof phase> { return phase.apply(this, args); }

  approval(...args: Parameters<typeof approval>): ReturnType<typeof approval> { return approval.apply(this, args); }

  withdrawApproval(...args: Parameters<typeof withdrawApproval>): ReturnType<typeof withdrawApproval> { return withdrawApproval.apply(this, args); }

  askQuestions(...args: Parameters<typeof askQuestions>): ReturnType<typeof askQuestions> { return askQuestions.apply(this, args); }

  questionKey(...args: Parameters<typeof questionKey>): ReturnType<typeof questionKey> { return questionKey.apply(this, args); }

  presentNextApproval(...args: Parameters<typeof presentNextApproval>): ReturnType<typeof presentNextApproval> { return presentNextApproval.apply(this, args); }

  settleApprovals(...args: Parameters<typeof settleApprovals>): ReturnType<typeof settleApprovals> { return settleApprovals.apply(this, args); }

  /** Esc on an empty composer, while a turn is parked for the quota reset:
   * the interactive loop's way to stop waiting (one press, then cleared). */
  idleEscape?: () => void;

  usage(label?: string, resetLabel?: string): void {
    if (this.usageLabel === label && this.usageResetLabel === resetLabel) return;
    this.usageLabel = label;
    this.usageResetLabel = resetLabel;
    this.schedulePaint();
  }

  statusText(...args: Parameters<typeof statusText>): ReturnType<typeof statusText> { return statusText.apply(this, args); }

  waitingLine(...args: Parameters<typeof waitingLine>): ReturnType<typeof waitingLine> { return waitingLine.apply(this, args); }

  escStops(...args: Parameters<typeof escStops>): ReturnType<typeof escStops> { return escStops.apply(this, args); }

  updateWaiting(...args: Parameters<typeof updateWaiting>): ReturnType<typeof updateWaiting> { return updateWaiting.apply(this, args); }

  schedulePaint(...args: Parameters<typeof schedulePaint>): ReturnType<typeof schedulePaint> { return schedulePaint.apply(this, args); }

  paintWaiting(...args: Parameters<typeof paintWaiting>): ReturnType<typeof paintWaiting> { return paintWaiting.apply(this, args); }

  repaint(...args: Parameters<typeof repaint>): ReturnType<typeof repaint> { return repaint.apply(this, args); }

  paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: PaletteLayout): void {
    const session = this.currentSession;
    if (!session || this.suspended) return;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.composer = {
      text: composer, options, selected, prompt, cursor,
      // Kept whole: a repaint (a resize) draws the list as it was asked for,
      // its section headings included.
      ...(palette ? { palette } : {}),
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
    const queuedMessages: Array<{ role: 'user'; content: string; queueState: string; unsteered?: boolean; user: boolean }> = [
      // A queued COMMAND is not a message and gets no row: it runs when the
      // turn ends and shows whatever it shows then. A notice does get a row,
      // and it is not the user's: Enter and Esc leave it.
      ...storedQueued.filter((item) => item.kind !== 'command')
        // Held by the running turn to steer in once no tool call is open
        // (acp-client.ts): it is on its way into this turn, not the next.
        .map((item) => ({
          role: 'user' as const, content: item.text, user: item.kind !== 'notification', ...(unsteeredIds.has(item.id) ? { unsteered: true } : {}),
          queueState: this.turn && item.heldForTurn && item.heldForTurn === pending?.startedAt ? 'pause' as const : 'queued' as const,
        })),
      ...this.waitingSubmissions.filter((item) => item.state !== 'steered' && !storedCopy(item)
        && !hasDurableSteer(item, pending?.steers ?? []))
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state, user: true, ...(item.unsteered ? { unsteered: true } : {}) })),
    ];
    // Enter again puts the oldest waiting user message into the chat, when
    // it would (enterAgainSends -- the key asks the same). Esc takes the
    // newest back. With one message they are the same row.
    const waitingUser = (message: { user: boolean; queueState: string }): boolean => message.user && !['steered', 'sending', 'error'].includes(message.queueState);
    const enterAt = this.turn?.sendWaiting && !this.turn.cancelled && !this.turn.draft.trim()
      && enterAgainSends(queuedMessages.filter(waitingUser).map((message) => ({ held: message.queueState === 'pause', ...(message.unsteered ? { unsteered: true } : {}) })))
      ? queuedMessages.findIndex(waitingUser) : -1;
    const escAt = this.turn?.takeBack ? queuedMessages.map(waitingUser).lastIndexOf(true) : -1;
    // The final status row is written without a trailing newline, so using
    // the complete terminal height is safe and important: leaving one row
    // unpainted allowed an obsolete status line to remain visibly duplicated.
    const targetHeight = this.viewportRows();
    const requestedPaletteCapacity = (typeof palette?.capacity === 'function' ? palette.capacity() : palette?.capacity)
      ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
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
    const noticeShown = notice ? noticeLines(notice, inner) : [];
    const indicatorText = this.turn ? backgroundTerminalsLabel(this.backgroundTerminals) : undefined;
    const budget = frameRowBudget({
      targetHeight, waiting: Boolean(this.turn), notice: noticeShown.length, requestedPaletteCapacity,
      indicator: indicatorText !== undefined,
    });
    const { waitingRows, noticeRows, paletteRows, indicatorRows } = budget;
    const paletteCapacity = paletteRows;
    let optionalRows = budget.optionalRows;
    const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
    // The software keyboard can make a mobile SSH viewport dramatically
    // shorter between two keystrokes. Bound the composer by what remains in
    // this exact frame so it can never create a physical terminal scroll.
    const approval = this.pendingApproval;
    // Never omitted (standard section 8): short of room the block degrades to
    // its question and keys (one row at the least), and the rows around it
    // give way first (fitFooterForApproval, below).
    const approvalSpace = Math.max(APPROVAL_MIN_ROWS, optionalRows - paletteRows);
    const approvalRows = approval?.question
      ? questionBlockRows(approval.question.state, width, Math.min(approvalSpace, Math.max(6, Math.floor(targetHeight * 0.6))), {
        guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS, needsFocus: approval.needsFocus, focused: approval.focused,
      })
      : approval
      ? approvalBlockRows(approval, width, Math.min(approvalSpace, Math.max(6, Math.floor(targetHeight * 0.6))), {
        guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS,
        needsFocus: approval.needsFocus, focused: approval.focused,
        position: this.approvalsAnswered + 1, total: this.approvalsAnswered + 1 + this.approvalQueue.length,
        canTell: Boolean(this.turn?.submit), telling: Boolean(this.tellingInstead),
      })
      : [];
    let liveBandBudget = Math.max(0, optionalRows - paletteRows - approvalRows.length - 2);
    // The newest words of the reasoning: it is read as it is written.
    const thought = this.thought ? reasoningBody(this.thought.text) : '';
    const thoughtRows = this.turn && thought && !approval && liveBandBudget > 0
      ? [`  ${chalk.dim(chalk.italic(`✻ ${visibleTail(thought, Math.max(1, inner - 2))}`))}`] : [];
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
      1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - indicatorRows - approvalRows.length - thoughtRows.length - signInRows.length - planRows.length - panelRows.length,
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
    // The call, and under it what it printed (tool-rows.ts): running and
    // settled at the same indent.
    const underCall = (line: string): string => underCallRow(line, conversationInner);
    // One blank row above a call, none below it: what follows -- the next
    // call, the next paragraph -- opens with its own, so the gap under a
    // call's output is one row, as the gap above it is. Activity between
    // messages (standaloneActivity) closes its own.
    const activityRows = (lines: readonly string[], category?: ToolCategory): string[] => (lines.length
      ? ['', ...lines.map((line, index) => (index > 0 ? underCall(line)
        : callRow(line, conversationInner, category ? TOOL_CATEGORY_STYLE[category].paint : undefined)))]
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
        rows.push(...activityRows(entry.lines, entry.event?.category), '');
      }
      return rows;
    };
    /** The in-flight turn's tools and steering messages, as rows that settle.
     * A call that is still running is `done: false`: the same slot in the
     * live region, spinner instead of the settled glyph, so finishing it
     * changes the glyph rather than moving the row. At the end of the turn
     * a tool that never reported completion settles anyway. */
    const refused = (entry: ActivityEntry): boolean => entry.decision !== undefined && entry.decision.kind !== 'approved';
    const toolRow = (entry: ActivityEntry, ended: boolean): SettlingTool => {
      const id = entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`;
      // A refused call is over, whatever the vendor has yet to say about it.
      const running = !ended && entry.event?.kind === 'tool-start' && !refused(entry);
      const order = { ...(entry.sequence === undefined ? {} : { seq: entry.sequence }), ...(entry.event?.agent ? { agent: true } : {}) };
      if (!running) {
        return {
          id, done: true, responseOffset: entry.responseOffset, ...order,
          lines: activityRows(entry.lines, entry.event?.category),
        };
      }
      const kind = entry.event?.swarm ? 'swarm' as const : (liveWaitKind(entry.event!) ?? 'tool');
      const frame = this.reducedMotion ? 0 : this.waitingFrame;
      const row = runningChatLine(
        tensedLabel(entry.event?.label ?? '', true), frame, kind, entry.event?.category,
      ).trim();
      // What it has printed so far, newest last, under the spinner -- a long
      // build or test run is visibly working instead of a bare timer.
      const live = entry.event ? outputPreviewRows({ ...entry.event, outputTail: true }, LIVE_OUTPUT_LINES).map(underCall) : [];
      // A sub-agent that has to be retired while it still runs: the same text
      // with a static glyph and `running`; when it settles one completion row
      // is appended (`✓ <label> (N tool uses · ...)`), and its live children
      // are named by a `↳ <label>` line (transcript.ts).
      const agentRows = entry.event?.agent ? (() => {
        const label = tensedLabel(entry.event.label, true);
        const settled = renderActivityLine({ ...entry.event, kind: 'tool-done' })[0]?.trim() ?? label;
        return {
          released: ['', `  ${runningChatLine(label, 0, kind, entry.event.category).trim()} ${chalk.dim('· running')}`],
          completed: ['', `  ${chalk.green('✓')} ${settled}`],
          childHeader: [`    ${chalk.dim(`↳ ${entry.event.label}`)}`],
        };
      })() : {};
      return {
        id, done: false, responseOffset: entry.responseOffset, ...order, ...agentRows,
        lines: ['', `  ${row}`, ...live],
      };
    };
    /** A run of reads and searches as one row (explore-groups.ts): the
     * summary, and under it the last calls, dimmed. Running, the summary
     * spins in the row's place; settled, it wears the work's glyph. */
    const groupRow = (group: TurnGroup<ActivityEntry & GroupRow>, ended: boolean): SettlingTool => {
      const first = group.members[0]!;
      const { summary, calls, running } = mergedExploreLines(group.members.map((member) => member.event), ended);
      const under = calls.map(underCall);
      if (running && !group.done) {
        const row = runningChatLine(summary, this.reducedMotion ? 0 : this.waitingFrame, 'tool', first.event?.category).trim();
        return { id: group.key, done: false, responseOffset: first.responseOffset, ...(first.sequence === undefined ? {} : { seq: first.sequence }), lines: ['', `  ${row}`, ...under] };
      }
      const { line, category } = mergedExploreSummaryLine(group.members.map((member) => member.event), summary);
      return { id: group.key, done: group.done, responseOffset: first.responseOffset, ...(first.sequence === undefined ? {} : { seq: first.sequence }), lines: [...activityRows([line], category), ...under] };
    };
    /** The turn's rows, looking-around runs merged. A lone call is its own
     * row as always, except that a finished read or search waits in the live
     * region while it is the tail: the next one may merge with it. */
    const groupedRows = (entries: readonly ActivityEntry[], ended: boolean, grouping: ExploreGrouping): SettlingTool[] => {
      // A call that is a row of its own: a note (lines and no event, from
      // activity()) or a call the user refused, whose row says so. Neither
      // can join a run of looking-around calls.
      const alone = (entry: ActivityEntry): boolean => !entry.event || refused(entry);
      const rows = entries.flatMap((entry) => (entry.event && !alone(entry) ? [{ ...entry, event: entry.event, key: entry.event.id ?? `activity#${entry.sequence ?? entry.responseOffset}` }] : []));
      const grouped = grouping.group(rows, ended, ended ? Number.POSITIVE_INFINITY : this.liveResponse.length).map((group) => {
        if (group.merged) return groupRow(group, ended);
        const row = toolRow(group.members[0]!, ended);
        return row.done && !group.done ? { ...row, done: false } : row;
      });
      return [...grouped, ...entries.filter(alone).map((entry) => toolRow(entry, ended))];
    };
    /** The running turn's own tool calls: anchored at the message count when
     * it began, which is at or before the index its answer lands at. */
    const turnEntries = (anchor: number): ActivityEntry[] => this.activityEntries.filter((entry) =>
      entry.anchor === anchor && entry.responseOffset !== undefined && !entry.event?.parentId);
    /** A saved message's calls, as rows: folded into entries by the same
     * upsert the running turn's events go through, and grouped and drawn by
     * the same functions, so a reopened turn looks as it did live. */
    const savedTools = (message: TranscriptMessage, index: number): SettlingTool[] => {
      const calls = readTurnActivities(message.activities, message.content.length).filter((activity) => !activity.event.parentId);
      const marks = readTurnMarks(message.marks);
      if (!calls.length && !marks.length) return [];
      // Calls and the turn's durable marks (a thought, the plan, a notice, an
      // approval's outcome) are drawn in one order (turn-mark-rows.ts), and a
      // mark is an entry like the settled thought is live, so it breaks a run
      // of reads the way it did while the turn ran.
      const ranks = savedTurnRanks(calls, marks);
      const at = (offset: number): number => Math.min(offset, message.content.length);
      let entries: ActivityEntry[] = [];
      for (const [position, activity] of calls.entries()) {
        entries = upsertActivityEvent(entries, index, at(activity.responseOffset), activity.event, ranks.activities[position]!, 0);
      }
      for (const [position, mark] of marks.entries()) {
        const on = callDecision(mark);
        if (on) {
          entries = settleDecisionEntry(entries, { anchor: index, responseOffset: at(mark.responseOffset), sequence: ranks.marks[position]!, ...on });
          continue;
        }
        const lines = turnMarkLines(mark);
        if (!lines.length) continue;
        entries.push({
          anchor: index, responseOffset: at(mark.responseOffset), sequence: ranks.marks[position]!,
          event: { kind: 'thinking', label: mark.id, id: mark.id }, lines,
        });
      }
      return groupedRows(entries, true, new ExploreGrouping());
    };
    const turnTools = (ended: boolean): SettlingTool[] => {
      const tools: SettlingTool[] = groupedRows(turnEntries(this.activityAnchor)
        // An anchor is reused: the next turn's assistant occupies the same
        // index when the previous one was never persisted. The turn that
        // produced an entry is what decides whether it belongs to this one.
        .filter((entry) => (entry.sequence ?? 0) > this.emitted.turnSequenceFloor), ended, this.exploreGrouping);
      // A running agent's live calls, one row each, nested under it. They are
      // never retired (the turn's end drops them with their parent) and never
      // gate another row; where they sit is child-rows.ts's rule.
      if (!ended) {
        const open = turnEntries(this.activityAnchor).filter((entry) => entry.event?.kind === 'tool-start' && entry.event.id
          && (entry.sequence ?? 0) > this.emitted.turnSequenceFloor);
        const frame = this.reducedMotion ? 0 : this.waitingFrame;
        for (const child of this.liveChildren.rows(open.map((entry) => ({ id: entry.event!.id!, offset: entry.responseOffset, seq: entry.sequence })))) {
          const uses = child.newest ? open.find((entry) => entry.event!.id === child.parentId)?.event?.childTools : undefined;
          tools.push({
            id: child.id, done: false, nested: true, parent: child.parentId, responseOffset: child.offset, seq: child.seq,
            lines: [`    ${chalk.cyan(waitingSpinnerGlyph(frame))} ${chalk.dim(`${child.label}${uses ? ` · ${toolUses(uses)}` : ''}`)}`],
          });
        }
      }
      // One row on each side, matching every other message: a steer is a
      // message the user wrote mid-answer.
      const steerRows = (text: string): string[] => [
        '', '', ...messageRows(text, userMarker), `  ${chalk.dim(`↳ ${STEER_WORDS.steered}`)}`, '',
      ];
      const steers = steerTranscriptRows({
        durable: pending?.steers ?? [], live: this.waitingSubmissions,
        materializedPendingTurn, retiredThisSession: this.emitted.retiredTexts(), render: steerRows,
      });
      for (const row of steers) this.turnSteers.set(row.id, row);
      // A steer drawn earlier is still this turn's row once its sources are
      // gone (the turn has ended: the saved list is all that is left of it).
      // It is owed under the id it was first drawn with -- once, whichever
      // copy arrives -- so it is drawn from what was kept, never again from
      // the saved user message that replaces it.
      tools.push(...(materializedPendingTurn ? steers : [...this.turnSteers.values()]));
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
      let message = persistedMessages[index]!;
      this.messageLines.set(index, this.alternateTrimmed + this.alternateTranscript.length + this.pendingFinished.length + finished.length);
      const pastTools = message.role === 'assistant' && index !== liveAssistant && !drewLiveTurn ? savedTools(message, index) : [];
      // A steered turn is saved as several messages and was drawn live as
      // one answer: the span of them is that answer, written once.
      const spanEnd = index === liveAssistant && message.role === 'assistant'
        ? liveTurnSpan(persistedMessages, index, [...this.turnSteers.values()]) : index;
      if (index === liveAssistant && message.role === 'assistant') {
        // The answer that just streamed. Its rows are already in scrollback and
        // the transcript knows exactly which blocks it still owes, so a
        // persisted copy that runs longer than what streamed -- a re-derived
        // answer, an interrupted turn -- contributes only its tail, and one
        // identical to what streamed contributes nothing at all.
        const answer = persistedMessages.slice(index, spanEnd + 1).filter((item) => item.role === 'assistant').map((item) => item.content).join('');
        emit(this.turnTranscript.advance({
          content: sanitizeTerminalText(answer), tools: turnTools(true), turnEnded: true, renderBlocks,
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
        this.turnSteers.clear();
        // The steers and the answers after them were that same drawing.
        for (let covered = index + 1; covered <= spanEnd; covered += 1) {
          this.messageLines.set(covered, this.messageLines.get(index) ?? 0);
          this.emitted.wrote(persistedMessages[covered]!);
        }
        index = spanEnd;
        message = persistedMessages[index]!;
      }
      // What the turn needed on the way -- a sign-in, another account --
      // saved with its answer, then its closing line.
      if (message.role === 'assistant' && message.signedInTo) emit(['', `  ${chalk.green('signed in to')} ${chalk.dim(message.signedInTo)}`]);
      if (message.role === 'assistant' && message.accountSwitch) emit(['', `  ${chalk.yellow(accountSwitchLine(message.accountSwitch))}`]);
      const ended = message.role === 'assistant' ? turnEndLine(persistedMessages, index) : undefined;
      if (ended) emit(['', `  ${chalk.dim(`─ ${ended} ─`)}`]);
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
        // What a running sub-agent may keep behind it: half of what the
        // conversation can show. Past it the agent row is retired as a
        // running line and the held text follows (transcript.ts).
        agentHoldRows: Math.max(3, Math.floor(maxComposerRows / 2)),
      });
      emit(step.finished);
      liveConversation.push(...step.live);
    }
    for (const [queueIndex, message] of queuedMessages.entries()) {
      // Provisional, and so never retired: a queued turn becomes a real user
      // message the moment it is sent, and would then be written a second time.
      // The keys before the note on why it queued: a narrow row drops parts
      // from the end, and what can be done is the part worth keeping. Esc
      // goes first when both do not fit: it is the shorter, and always works.
      const enterKey = queueIndex === enterAt ? [STEER_WORDS.sendNow] : [];
      const escKey = queueIndex === escAt ? [keyHint('takeBack')] : [];
      const statusWith = (keys: readonly string[]): string => {
        const said = keys.map((key) => ` · ${key}`).join('');
        return message.queueState === 'steered' ? STEER_WORDS.steered
          : message.queueState === 'sending' ? 'submitting…'
            : message.queueState === 'pause' ? `${STEER_WORDS.held}${said}`
              : message.queueState === 'error' ? 'not sent · restored for editing'
                : `queued for next turn${said}${message.unsteered ? ` · ${STEER_WORDS.unsteered}` : ''}`;
      };
      const hintRoom = Math.max(1, inner - 4);
      const roomy = statusWith([...enterKey, ...escKey]);
      const status = terminalCellWidth(roomy) <= hintRoom ? roomy : statusWith([...escKey, ...enterKey]);
      // One row, the same separator the transcript gives every other message:
      // a message submitted mid-turn is still a message the user wrote.
      // The speaker changes once, where the queue begins: two rows there, the
      // same break a settled prompt gets. Between queued messages it is one --
      // they are a list of things the same person wrote, not a new speaker
      // each time.
      liveConversation.push(...(queueIndex === 0 ? ['', ''] : ['']),
        ...userRows(message.content), `  ${chalk.dim(`↳ ${fitHint(status, hintRoom)}`)}`);
    }
    const conversationLines = liveConversationLines(liveConversation, true);
    const meta = this.statusText(inner);
    const footer: string[] = [];
    // The resting composer starts with a clear row, or its rule sits directly
    // on the last line of the answer. While a turn runs the generating band
    // already carries its own blank, budgeted into the height -- adding a
    // second one there would double the gap and push an answer row off.
    if (!this.turn) footer.push('');
    footer.push(...noticeShown.slice(0, noticeRows).map((row) => `  ${chalk.yellow(row)}`));
    if (paletteCapacity) {
      footer.push(...paletteBandRows(options as readonly PaletteEntry[], selected, paletteCapacity, width, {
        ...(palette?.headings ? { headings: true } : {}), ...(palette?.hint ? { hint: palette.hint } : {}),
      }));
    }
    footer.push(...panelRows, ...planRows);
    const aboveApproval = footer.length;
    const midRows = [...thoughtRows, ...(signInRows.length ? ['', ...signInRows] : [])];
    footer.push(...approvalRows, ...midRows);
    // The generating band: a blank above the status where the height has the
    // row for it. The status itself is always drawn while a turn runs.
    const statusBlank = waitingRows >= 2 && this.turn ? '' : undefined;
    const statusRow = this.turn ? `  ${visibleSlice(this.waitingLine(this.turn, Math.max(1, inner)), Math.max(1, inner))}` : undefined;
    if (statusBlank !== undefined) footer.push(statusBlank);
    if (statusRow !== undefined) footer.push(statusRow);
    // Background terminals the vendor runs: one dim row under the status,
    // not drawn at zero, and the first row a short terminal gives up.
    const indicatorRow = indicatorRows && indicatorText !== undefined
      ? `  ${chalk.dim(visibleSlice(indicatorText, Math.max(1, inner)))}` : undefined;
    if (indicatorRow !== undefined) footer.push(indicatorRow);
    // Usage lives on the upper composer border, mirroring the title on the
    // lower border. A spent window replaces the percentage with the reset
    // itself (`Resets 5:34PM`); a spent balance says `Out Of Credits`.
    const usageRule = paintUsageRule(rowWidth, composerUsageLabel(this.usageLabel, this.usageResetLabel));
    footer.push(usageRule);
    let composerStart = footer.length;
    const composerFooter: string[] = [];
    for (const [index, row] of composerRows.rows.entries()) {
      // The caret is drawn in the same foreground as the rules and the text
      // between them, so the whole composer reads as one field: white frame,
      // white prompt, white input.
      composerFooter.push(`  ${index === 0 ? chalk.bold(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
    }
    footer.push(...composerFooter);
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    const titleRule = paintTitleRule(rowWidth, session.name || undefined);
    footer.push(titleRule);
    // Provider, model, effort and directory are one statement -- what this
    // conversation is running as -- so they read as one line in one colour
    // rather than a bright word followed by a dimmer tail. Cyan is ClikCode's
    // own chrome, the same family as the caret above it.
    const metaRow = `  ${chalk.cyan(meta)}`;
    footer.push(metaRow);
    // A short terminal with an approval up: the rows that are not the prompt
    // go first, so it is never the prompt that is cut off the top.
    if (approvalRows.length && footer.length > targetHeight) {
      const fitted = fitFooterForApproval({
        above: footer.slice(0, aboveApproval), approval: approvalRows, mid: midRows, blank: statusBlank, status: statusRow,
        indicator: indicatorRow,
        usageRule, composer: composerFooter, titleRule, meta: metaRow, height: targetHeight,
      });
      footer.splice(0, footer.length, ...fitted.rows);
      composerStart = fitted.composerStart;
    }

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
    // The two moments a user feels, once per turn each (runtime/turn-latency.ts):
    // their message on screen, and the first of the answer.
    if (pendingPrompt && turnMarkOpen('first-paint')) markTurn('first-paint');
    if (this.turn && turnMarkOpen('first-text-paint') && this.liveResponse.trim()) markTurn('first-text-paint');
  }

  /** The last frame's live rows made safe, by the row as built and the width. */
  safeLiveRows = { limit: 0, rows: new Map<string, string>() };

  /** One frame: `finished` rows are retired into the transcript, and the live
   * region below them is replaced. */
  renderFrame(
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

  flushFrame(): void {
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
  flushAlternateFrame(
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

  showMention(...args: Parameters<typeof showMention>): ReturnType<typeof showMention> { return showMention.apply(this, args); }

  mentionKey(...args: Parameters<typeof mentionKey>): ReturnType<typeof mentionKey> { return mentionKey.apply(this, args); }

  endMention(...args: Parameters<typeof endMention>): ReturnType<typeof endMention> { return endMention.apply(this, args); }

  jumpToMention(...args: Parameters<typeof jumpToMention>): ReturnType<typeof jumpToMention> { return jumpToMention.apply(this, args); }

  scrollTranscript(...args: Parameters<typeof scrollTranscript>): ReturnType<typeof scrollTranscript> { return scrollTranscript.apply(this, args); }

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
  pendingScroll = 0;
  /** True while the frame being drawn is the result of a scroll. */
  paintingScroll = false;
  scrollDrainTimer?: NodeJS.Timeout;
  drainScroll(...args: Parameters<typeof drainScroll>): ReturnType<typeof drainScroll> { return drainScroll.apply(this, args); }

  queueScroll(...args: Parameters<typeof queueScroll>): ReturnType<typeof queueScroll> { return queueScroll.apply(this, args); }

  stopDrainBatch?: () => void;
  drainAtBatchEnd(...args: Parameters<typeof drainAtBatchEnd>): ReturnType<typeof drainAtBatchEnd> { return drainAtBatchEnd.apply(this, args); }

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
  scrollPaintQueued = false;
  stopScrollBatch?: () => void;
  scheduleScrollPaint(...args: Parameters<typeof scheduleScrollPaint>): ReturnType<typeof scheduleScrollPaint> { return scheduleScrollPaint.apply(this, args); }

  /** True while the reader is looking at something other than the live end. */
  get scrolledBack(): boolean { return this.alternateScrollback > 0; }

  handleScrollKey(...args: Parameters<typeof handleScrollKey>): ReturnType<typeof handleScrollKey> { return handleScrollKey.apply(this, args); }

  handleSelection(...args: Parameters<typeof handleSelection>): ReturnType<typeof handleSelection> { return handleSelection.apply(this, args); }

  lineAtScreenRow(...args: Parameters<typeof lineAtScreenRow>): ReturnType<typeof lineAtScreenRow> { return lineAtScreenRow.apply(this, args); }

  selectionText(...args: Parameters<typeof selectionText>): ReturnType<typeof selectionText> { return selectionText.apply(this, args); }

  followSelectionEdge(...args: Parameters<typeof followSelectionEdge>): ReturnType<typeof followSelectionEdge> { return followSelectionEdge.apply(this, args); }

  stepSelectionScroll(...args: Parameters<typeof stepSelectionScroll>): ReturnType<typeof stepSelectionScroll> { return stepSelectionScroll.apply(this, args); }

  stopSelectionScroll(...args: Parameters<typeof stopSelectionScroll>): ReturnType<typeof stopSelectionScroll> { return stopSelectionScroll.apply(this, args); }

  redrawSelection(...args: Parameters<typeof redrawSelection>): ReturnType<typeof redrawSelection> { return redrawSelection.apply(this, args); }

  noteReadingDirection(...args: Parameters<typeof noteReadingDirection>): ReturnType<typeof noteReadingDirection> { return noteReadingDirection.apply(this, args); }

  forgetScreenPosition(...args: Parameters<typeof forgetScreenPosition>): ReturnType<typeof forgetScreenPosition> { return forgetScreenPosition.apply(this, args); }

  notice(...args: Parameters<typeof notice>): ReturnType<typeof notice> { return notice.apply(this, args); }

  showTransientNotice(...args: Parameters<typeof showTransientNotice>): ReturnType<typeof showTransientNotice> { return showTransientNotice.apply(this, args); }

  clearTransientNotice(...args: Parameters<typeof clearTransientNotice>): ReturnType<typeof clearTransientNotice> { return clearTransientNotice.apply(this, args); }

  suspendToShell(...args: Parameters<typeof suspendToShell>): ReturnType<typeof suspendToShell> { return suspendToShell.apply(this, args); }

  readonly onContinue = (...args: Parameters<typeof onContinue>): ReturnType<typeof onContinue> => onContinue.apply(this, args);

  /** Remove a completed palette/picker as one frame. Painting an empty
   * composer here left its borders/status rows alive while the selected slash
   * command ran, which looked like a composer floating above blank space. */
  clearInteractiveFrame(): void {
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
          const hint = options[0]?.completes ? [keyHintFor('↑↓', 'choose'), keyHintFor('tab', 'fill in'), keyHint('apply'), keyHintFor('esc', 'clear')].join(' · ')
            : value.includes(' ') ? `${keyHintFor('enter', 'run')} · ${keyHintFor('esc', 'clear')}` : undefined;
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
          // When the palette is open (any options match), right arrow selects/runs the highlighted option
          if (options.length && cursor >= value.length) return runCommand(options[selected].value);
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
        const edited = editWaitingComposer(value, cursor, key);
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

  pickerHost(): OptionPickerHost {
    return {
      paint: (composer, pickerOptions, selected, prompt, cursor, palette) =>
        this.paint(composer, pickerOptions, selected, prompt, cursor, palette),
      clearFrame: () => this.clearInteractiveFrame(),
      repair: () => { this.requestRedraw('repair'); this.forgetScreenPosition(); },
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

  /** The terminal said it lost focus and has not said it got it back. One
   * that never reports focus is always looked at. */
  lookedAway(): boolean {
    return this.focus.focused === false;
  }

  /** Nothing is using this terminal: no turn, no picker, no palette, and no
   * typed or queued draft. A newer build may replace the process here. */
  idleForBuildReplace(): boolean {
    return !this.closed && !this.suspended && !this.selecting && !this.paletteActive
      && !this.turn && !this.composer.text && !this.queuedDraft;
  }

  close(...args: Parameters<typeof close>): ReturnType<typeof close> { return close.apply(this, args); }

  suspend(...args: Parameters<typeof suspend>): ReturnType<typeof suspend> { return suspend.apply(this, args); }

  resume(...args: Parameters<typeof resume>): ReturnType<typeof resume> { return resume.apply(this, args); }
}
