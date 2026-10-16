/** The interactive terminal, drawn on the alternate screen: the conversation
 * as a transcript this UI keeps and scrolls itself, and below it one live
 * region holding the changing response, controls and composer. Every row is
 * written at an address, and a frame writes only the rows that changed. */

import { lifecycle, setLifecycleSession } from '../runtime/lifecycle-log.js';
import type { PaletteEntry } from './command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { createStreamingBlockParser } from './render/markdown.js';
import { ENTER_ALTERNATE_SCREEN, installTerminalRestoreSignals, REEXEC_TERMINAL_ENV, restoreTerminal, terminalModes, terminalPrepare } from './restore.js';
import type { FocusState } from './terminal-signals.js';
import { sessionTranscriptMessages, settledTranscriptMessages } from '../turn/checkpoint.js';
import { TurnTranscript } from '../turn/transcript.js';
import type { HarnessPrompter, JournalState, PickerOption, PickerSettings } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';
import { ActivityEntry, commonPrefixLength, rebaseActivityOffsets } from './render/activity-log.js';
import type { OpenTool, Thought } from '../harness/protocol/activity-view.js';
import { logProcessWarnings } from './warnings.js';
import { CallGrouping, GroupRegistry } from './render/call-groups.js';
import { GroupExpansion } from './render/group-rows.js';
import { toggleLatestGroup, tapGroupRow, type GroupAnchor, type AnchorTarget } from './prompter/group-actions.js';
import { ApprovalRequest } from './render/approval-block.js';
import { EmittedTranscript } from './render/emitted-transcript.js';
import { LiveChildren } from './render/child-rows.js';
import type { SteerRow } from './render/steer-rows.js';
import { pendingPromptText } from './render/pending-prompt.js';
import type { MentionFocus } from './render/search-focus.js';
import type { Selection } from './render/selection.js';
import { reducedMotion } from './capabilities.js';
import { KEEP_STDIN_FLOWING, onTerminalFocus } from './input-decoder.js';
import { sessionModesOn, type Redraw } from './modes.js';
import { PlanEntry } from './render/plan-block.js';
import { type ComposerFrame, EMPTY_COMPOSER, type WaitingTurn } from './prompter/state.js';
import { retakeScreen, retakeTerminalSignals, takeTerminalTitle, terminalSignals, notifyIfAway, suspendToShell, onContinue, close, suspend, resume } from './prompter/terminal-lifecycle.js';
import { scrollTranscript, drainScroll, queueScroll, drainAtBatchEnd, scheduleScrollPaint, handleScrollKey, handleSelection, lineAtScreenRow, selectionText, followSelectionEdge, stepSelectionScroll, stopSelectionScroll, redrawSelection, noteReadingDirection, forgetScreenPosition } from './prompter/scroll-selection.js';
import { showMention, mentionKey, endMention, jumpToMention } from './prompter/mention.js';
import { showTransientNotice, clearTransientNotice, panel, panelKey } from './prompter/notices.js';
import { answerApproval, restoreTellingDraft, approval, withdrawApproval, askQuestions, questionKey, presentNextApproval, settleApprovals } from './prompter/approvals.js';
import { activity, setPlan, settlePlan, activityEvent, settleThought, markDrawn, joinMark, joinThought, settleDecision, ofThisTurn, settleSavedStops } from './prompter/activity-state.js';
import { editTurnDraft, waitingUserMessages, enterAgainReady, turnHasAnswer, takeBackWaiting, submitWaiting, waitingLabel, updateWaitingLabel, joinedWaiting, startWaiting, turnStarting, toolStatus, turnWaits, waitingOnUser, scheduleWaitingTick, stepTokens, setTurnUsage, setBackgroundWork, pauseClock, resumeClock, flushWaitingSubmissions, leaveTurn, turnStopped, turnStopping, stopSettled, onWaitingEnded, stopWaiting, vendorAnswered, phase } from './prompter/waiting-turn.js';
import { statusText, waitingLine, escStops, updateWaiting, schedulePaint, paintWaiting, repaint } from './prompter/waiting-band.js';
import { onWaitingKey } from './prompter/waiting-keys.js';
import { openSubView, closeSubView, subViewKey, paintSubView, type SubView } from './prompter/subagent-host.js';
import { viewportRows, onResize, repaintAfterResize, rewrapIfWidthChanged, clearTranscript } from './prompter/viewport.js';
import { signInScreen } from './prompter/sign-in.js';
import { renderFrame, flushFrame, flushAlternateFrame } from './prompter/frame-flush.js';
import { clearInteractiveFrame, select, board, pickerHost } from './prompter/picker-host.js';
import { question } from './prompter/prompt-input.js';
import { paint } from './prompter/paint/frame.js';


/** Rows of the live conversation with their group tags. */
export type ScrollTail = { rows: string[]; tags: Array<string | undefined> };
const EMPTY_TAIL: ScrollTail = { rows: [], tags: [] };

export class TerminalHarnessPrompter implements HarnessPrompter {
  closed = false;
  history: string[] = [];
  currentSession?: HarnessSession;
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
  /** The calls sub-agents of this turn made (parentId), bounded per agent, kept so an agent's row can open to them. */
  childEntries: ActivityEntry[] = [];
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
  /** Waiting messages Esc has asked the worker to hand back and it has not yet answered (`unqueued`): drawn nowhere, taken back once. */
  takingBack = new Set<string>();
  /** The calls still open: the status line names the newest (toolStatus). */
  activeTools = new Map<string, OpenTool>();
  /** The calls inside running sub-agents, one live slot each
   * (render/child-rows.ts). Drawn nested under the agent, never retired. */
  readonly liveChildren = new LiveChildren();
  /** When each running sub-agent's row was first drawn, for its clock. */
  readonly agentStarts = new Map<string, number>();
  /** Which of this turn's calls and thoughts are one group (call-groups.ts). */
  readonly callGrouping = new CallGrouping();
  /** The groups of this view, kept so one can be opened (call-groups.ts). */
  readonly callGroups = new GroupRegistry();
  /** Which groups and items are open, read by the rows (render/group-rows.ts). */
  readonly groupExpansion = new GroupExpansion();
  /** Where a toggled group's row must land once the transcript is written again (group-actions.ts). */
  groupAnchor?: GroupAnchor;
  anchorTarget?: AnchorTarget;
  /** The tag of each transcript line that belongs to a group, by line
   * number (alternateTrimmed + index), taken out of the row text where the
   * frame is built (render/row-tags.ts). */
  readonly lineTags = new Map<number, string>();
  liveResponse = '';
  responsePaintTimer?: NodeJS.Timeout;
  frameInFlight = false;
  /** Why the next frame that draws rows is drawn, when it is not routine:
   * after a resize, or a repair (Ctrl+L). See redrawPreamble. */
  pendingRedraw: Redraw | undefined;
  queuedDraft?: string;
  /** The last conversation turn ended stopped; read once by the loop (takeStopped). */
  turnEndedStopped = false;
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
  pendingLive?: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean; tags: Array<string | undefined>; tail?: ScrollTail };
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
  frameLayout = { live: [] as string[], tags: [] as Array<string | undefined> };
  /** The live conversation's rows (a running agent, the answer being written),
   * all of them, as of the last frame. Scrolled back they are the end of what
   * can be read -- they are not in the transcript until they retire. */
  scrollTail: ScrollTail = { rows: [], tags: [] };
  /** The scrollable length (transcript plus tail) of the last frame drawn
   * scrolled back: what holds the view still while rows arrive. */
  scrollBodyLength: number | undefined;
  /** The rows the view scrolls over beyond the transcript: the live tail, while scrolled back. */
  get viewExtra(): ScrollTail { return this.alternateScrollback > 0 ? this.scrollTail : EMPTY_TAIL; }
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
  /** The sub-agent open in full view, if one is (prompter/subagent-host.ts). */
  subView?: SubView;
  /** Sends a message typed into a sub-agent's view to the worker; resolves to the refusal, if any. Set by the window that follows the turn. */
  subAgentSteer?: (ref: import('../harness/protocol/activity-normalize.js').SubAgentRef, text: string) => Promise<string | undefined>;
  openSubView(...args: Parameters<typeof openSubView>): ReturnType<typeof openSubView> { return openSubView.apply(this, args); }
  closeSubView(...args: Parameters<typeof closeSubView>): ReturnType<typeof closeSubView> { return closeSubView.apply(this, args); }
  subViewKey(...args: Parameters<typeof subViewKey>): ReturnType<typeof subViewKey> { return subViewKey.apply(this, args); }
  paintSubView(...args: Parameters<typeof paintSubView>): ReturnType<typeof paintSubView> { return paintSubView.apply(this, args); }
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

  render(session: HarnessSession, _account?: string, journal?: JournalState): void {
    if (this.currentSession?.id !== session.id) {
      setLifecycleSession(session.id);
      lifecycle('window.conversation', { from: this.currentSession?.id ?? null, harness: session.nativeHarness ?? session.route });
      // A /search mention belongs to the conversation it was found in.
      if (this.mentionFocus?.sessionId !== session.id) this.mentionFocus = undefined;
      this.activityEntries = [];
      this.childEntries = [];
      this.planEntries = [];
      this.planStart = undefined;
      this.panelState = undefined;
      this.groupExpansion.clear();
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
    // A running turn's composer is its draft, not empty. While it runs the
    // frame goes through the coalescing scheduler: a snapshot, a queue change
    // and a stop arrive together, and a direct paint drew each in between.
    if (this.turn) this.updateWaiting();
    else this.paint('', [], 0, '› ', 0);
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

  signInScreen(...args: Parameters<typeof signInScreen>): ReturnType<typeof signInScreen> { return signInScreen.apply(this, args); }

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
  /** Whether the turn that just ended was stopped: what was queued behind it must not run on its own. */
  takeStopped(): boolean { const stopped = this.turnEndedStopped; this.turnEndedStopped = false; return stopped; }
  markTurnStopped(): void { this.turnEndedStopped = true; }
  flushWaitingSubmissions(...args: Parameters<typeof flushWaitingSubmissions>): ReturnType<typeof flushWaitingSubmissions> { return flushWaitingSubmissions.apply(this, args); }

  leaveTurn(...args: Parameters<typeof leaveTurn>): ReturnType<typeof leaveTurn> { return leaveTurn.apply(this, args); }

  turnStopped(...args: Parameters<typeof turnStopped>): ReturnType<typeof turnStopped> { return turnStopped.apply(this, args); }
  turnStopping(...args: Parameters<typeof turnStopping>): ReturnType<typeof turnStopping> { return turnStopping.apply(this, args); }
  stopSettled(...args: Parameters<typeof stopSettled>): ReturnType<typeof stopSettled> { return stopSettled.apply(this, args); }

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

  paint(...args: Parameters<typeof paint>): ReturnType<typeof paint> { return paint.apply(this, args); }

  /** The last frame's live rows made safe, by the row as built and the width. */
  safeLiveRows = { limit: 0, rows: new Map<string, string>() };

  renderFrame(...args: Parameters<typeof renderFrame>): ReturnType<typeof renderFrame> { return renderFrame.apply(this, args); }

  flushFrame(...args: Parameters<typeof flushFrame>): ReturnType<typeof flushFrame> { return flushFrame.apply(this, args); }

  flushAlternateFrame(...args: Parameters<typeof flushAlternateFrame>): ReturnType<typeof flushAlternateFrame> { return flushAlternateFrame.apply(this, args); }

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

  toggleLatestGroup(...args: Parameters<typeof toggleLatestGroup>): ReturnType<typeof toggleLatestGroup> { return toggleLatestGroup.apply(this, args); }

  tapGroupRow(...args: Parameters<typeof tapGroupRow>): ReturnType<typeof tapGroupRow> { return tapGroupRow.apply(this, args); }

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

  showTransientNotice(...args: Parameters<typeof showTransientNotice>): ReturnType<typeof showTransientNotice> { return showTransientNotice.apply(this, args); }

  clearTransientNotice(...args: Parameters<typeof clearTransientNotice>): ReturnType<typeof clearTransientNotice> { return clearTransientNotice.apply(this, args); }

  suspendToShell(...args: Parameters<typeof suspendToShell>): ReturnType<typeof suspendToShell> { return suspendToShell.apply(this, args); }

  readonly onContinue = (...args: Parameters<typeof onContinue>): ReturnType<typeof onContinue> => onContinue.apply(this, args);

  clearInteractiveFrame(...args: Parameters<typeof clearInteractiveFrame>): ReturnType<typeof clearInteractiveFrame> { return clearInteractiveFrame.apply(this, args); }

  question(...args: Parameters<typeof question>): ReturnType<typeof question> { return question.apply(this, args); }

  select<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: PickerSettings<T>,
  ): Promise<T | undefined> {
    const run = select<T>;
    return run.call(this, title, options, onAction, settings);
  }

  board(...args: Parameters<typeof board>): ReturnType<typeof board> { return board.apply(this, args); }

  pickerHost(...args: Parameters<typeof pickerHost>): ReturnType<typeof pickerHost> { return pickerHost.apply(this, args); }

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
