/** The interactive terminal: one atomic live region holding the changing
 * response, controls and composer, with persisted conversation lines emitted
 * once into native scrollback. */

import chalk from 'chalk';
import { pastedText } from './keys.js';
import { backslashNewline, composerVerticalMove, editComposer, editWaitingComposer } from './composer-edit.js';
import { commandPaletteMatches, completedCommandLine, composerRightArrowValue, exactPaletteCommand, paletteDisplayRows, pickerConfirmsSelection, pickerDeletesSelection, type PaletteEntry } from './command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { composerLayout } from './render/composer-layout.js';
import { closeOpenHyperlink } from './render/hyperlinks.js';
import { createStreamingBlockParser, splitIntoBlocks } from './render/markdown.js';
import { sanitizeTerminalText } from './render/text.js';
import { nextCharacterIndex, previousCharacterIndex, terminalCellWidth, visibleSlice } from './render/width.js';
import { wrapCodeLine } from './render/wrap.js';
import { installTerminalRestoreSignals, restoreTerminal, terminalModes, terminalPrepare, terminalTeardown } from './restore.js';
import { compactPath, sessionProviderLabel } from '../harness/protocol/labels.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';
import { TurnTranscript, type SettlingTool } from '../turn/transcript.js';
import { nativeModelLabel } from '../harness/accounts/model-catalog.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { HarnessActivityEvent, HarnessPrompter, MessageBlock, PickerOption, ToolCategory } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';
import { ActivityEntry, collapseToolRuns, activityLifecyclePhase, rebaseActivityOffsets, transientAssistantRequired, upsertActivityEvent } from './render/activity-log.js';
import { TOOL_CATEGORY_STYLE } from '../harness/protocol/tool-category-style.js';
import { APPROVAL_GUARD_MS, ApprovalPreview, ApprovalRequest, approvalBlockRows, approvalKeyAction } from './render/approval-block.js';
import { frameRowBudget } from './render/frame-budget.js';
import { runOptionPicker } from './option-picker.js';
import { EmittedTranscript } from './render/emitted-transcript.js';
import { steerTranscriptRows } from './render/steer-rows.js';
import { pendingPromptText } from './render/pending-prompt.js';
import { commandLineTypedDuringTurn } from './waiting-slash.js';
import { renderMessageBlocks } from './render/message-blocks.js';
import { reducedMotion } from './capabilities.js';
import { logCursorEvent } from './cursor-log.js';
import { KEEP_STDIN_FLOWING, inKeyBatch, listenForTerminalKeys, onKeyBatchEnd, waitingInputAction } from './input-decoder.js';
import { ENABLE_BRACKETED_PASTE, ENABLE_MOUSE_TRACKING, OPENING_MOUSE_TRACKING, SELECTION_MODE, SWIPE_ROWS, enterInputModes, isMouseEvent, popReadModes, setTerminalRawMode, wheelScrollRows } from './modes.js';
import { PlanEntry, planBlockRows } from './render/plan-block.js';
import { formatTurnUsage } from './render/usage-line.js';
import { liveConversationLines, paintTitleRule, paintUsageRule, rightLabeledRule, waitingSpinnerGlyph } from './render/waiting.js';

const EXIT_CONFIRM_MS = 2000;

/** How long a resize burst is given to finish before the screen is redrawn.
 * A phone dismissing its keyboard emits several SIGWINCHes a few tens of
 * milliseconds apart; this is longer than that gap and shorter than a frame a
 * reader would notice missing. */
const RESIZE_SETTLE_MS = 120;

/** The least a pending scroll moves in one frame, so a drain always finishes.
 * Claude Code's value. */
const SCROLL_DRAIN_MIN = 4;

/** One frame, roughly: the gap between drains of an outstanding scroll. */
const SCROLL_DRAIN_MS = 16;

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';

const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l';

/** Rows kept above the viewport so scrolling back inside a conversation still
 * has somewhere to scroll to. */
const ALTERNATE_TRANSCRIPT_ROWS = 2000;

export class TerminalHarnessPrompter implements HarnessPrompter {
  private closed = false;
  private history: string[] = [];
  private currentSession?: HarnessSession;
  private currentAccount?: string;
  private currentNotice?: string;
  private draft = '';
  private draftOptions: readonly PickerOption<string>[] = [];
  private draftSelected = 0;
  private draftPrompt = '› ';
  private draftCursor = 0;
  private draftPalette?: { capacity?: number; hint?: string; hideCursor?: boolean };
  private waitingTimer?: NodeJS.Timeout;
  private stopWaitingInput?: () => void;
  private waitingFrame = 0;
  private waitingLabel = '';
  private waitingStartedAt = 0;
  private activityEntries: ActivityEntry[] = [];
  private activeTools = new Map<string, { label: string; category?: ToolCategory }>();
  /** Category of the tool the waiting band is currently reporting, so the
   * spinner is tinted by what is actually happening. */
  private waitingCategory?: ToolCategory;
  private liveResponse = '';
  private responsePaintTimer?: NodeJS.Timeout;
  private frameInFlight = false;
  private queuedDraft?: string;
  private waitingDraft = '';
  private waitingCursor = 0;
  private waitingSubmit?: (text: string) => Promise<LiveTurnInputResult>;
  /** `id` arrives with the answer to the submission, and is the same id its
   * durable copy (a queued turn, a recorded steer) is stored under. */
  private waitingSubmissions: Array<{ localId: number; id?: string; text: string; responseOffset: number; sequence: number; state: 'sending' | 'queued' | 'steered' | 'error' | 'command' }> = [];
  private waitingSubmissionId = 0;
  private timelineSequence = 0;
  private readonly waitingSubmissionWrites = new Set<Promise<void>>();
  private suspended = false;
  private readonly reducedMotion = reducedMotion();
  private activityAnchor = 0;
  /** Everything this UI writes goes through one append-only stream: finished
   * rows into native scrollback, one small live region below them. */
  private pendingFinished: string[] = [];
  private pendingLive?: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean };
  /** The last row retired, so a blank separator is never doubled across the
   * boundary between one frame and the next. */
  private lastFinishedRow?: string;
  /** The row before it, so the guard that separates messages can tell one
   * empty row from two across a frame boundary. */
  private secondLastFinishedRow?: string;
  /** Persisted messages already in scrollback, and the standalone activity
   * rows already written. Everything before `emittedMessages` belongs to the
   * terminal now; this UI never addresses it again. */
  /** `role:content` of the last message written to the transcript -- the seam
   * the next frame carries on from, which a count cannot identify once the
   * caller hands a window of the conversation rather than all of it. */
  /** Sequence numbers of the standalone activity rows already retired. One
   * number per activity event, alongside activityEntries itself, which is
   * deliberately never evicted -- some of it is immutable scrollback. */
  /** User text already retired, so a steer materialized into the transcript by
   * an earlier frame is not drawn a second time as a live row. */
  /** Where the answer currently streaming will land once it is persisted, so
   * the persisted copy adds only what the stream had not already retired. */
  private readonly turnTranscript = new TurnTranscript();
  /** What is already in the terminal's scrollback. See emitted-transcript.ts:
   *  every write there is irreversible, so the rules live in one place. */
  private readonly emitted = new EmittedTranscript();
  /** Timeline sequence this turn started at, so activity left over from an
   * earlier turn at the same anchor is never adopted into it. */
  /** Write the windowed history once: the first frame of the process, and the
   * first frame of a newly opened session. */
  private lastColumns = output.columns || 0;
  private usageLabel?: string;
  private usageResetLabel?: string;
  private selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever draftOptions happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  private paletteActive = false;
  /** What the composer's slash palette offers, remembered from the last
   * question() so a turn in flight can offer the same commands. A turn does
   * not change which commands exist; each is re-checked when it runs. */
  private paletteCommands: readonly PaletteEntry[] = [];
  private waitingCommand?: (text: string) => Promise<LiveTurnInputResult>;
  /** The prompt this client submitted, held from Enter until the turn ends.
   * See render/pending-prompt.ts: the snapshot alone cannot draw it for the
   * whole turn, so the client keeps its own copy of what it sent. */
  private submittedPrompt?: string;
  private cancelWaiting?: (restoreDraft: boolean) => void;
  private waitingCancelled = false;
  private pendingApproval?: ApprovalRequest & { shownAt: number; needsFocus: boolean; focused: boolean };
  private approvalGuardTimer?: NodeJS.Timeout;
  /** A short-lived hint (the Ctrl+C exit warning) that takes the notice row. */
  private transientNotice?: string;
  private transientNoticeTimer?: NodeJS.Timeout;
  private turnUsage?: { inputTokens?: number; outputTokens?: number };
  private latestThought?: string;
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
  private approvalRestoreLabel?: string;
  private readonly onWaitingKey = (key: string): void => {
    // Before approvals and before the draft: a turn running is when someone
    // wants to read what went past.
    if (!this.pendingApproval && this.handleScrollKey(key)) return;
    // Escape backs out one level, as it does everywhere else. Scrolled back
    // mid-turn it returns to the live edge; pressed again -- now at the edge,
    // where the band that says "esc to interrupt" is the thing being looked
    // at -- it interrupts.
    //
    // It used to interrupt on the first press regardless, which was a fair
    // call when scrolled-back reading was not really usable during a turn.
    // Now that the page holds still while a turn streams, the only way back
    // to the live edge was to kill the turn, so reading what went past cost
    // the answer being read.
    if (!this.pendingApproval && key === '\u001b' && this.scrolledBack) {
      this.scrollTranscript(-Number.MAX_SAFE_INTEGER);
      return;
    }
    if (this.pendingApproval) {
      // The draft is never edited from here: every key is either an answer or
      // dropped, so the composer is exactly as the user left it afterwards.
      const pending = this.pendingApproval;
      const action = approvalKeyAction(key, Date.now() - pending.shownAt, pending.needsFocus, pending.focused, Boolean(pending.rule));
      if (action === 'focus') {
        pending.focused = true;
        this.updateWaiting();
      } else if (action === 'allow' || action === 'always' || action === 'deny') {
        this.pendingApproval = undefined;
        pending.resolve(action === 'deny' ? false : action === 'always' ? 'always' : true);
        if (!this.presentNextApproval()) {
          this.waitingLabel = this.approvalRestoreLabel || 'thinking';
          this.approvalRestoreLabel = undefined;
          this.updateWaiting();
        }
      }
      return;
    }
    const action = waitingInputAction(key);
    if (action === 'cancel-edit' || action === 'cancel-stop') {
      if (this.waitingCancelled) return;
      this.waitingCancelled = true;
      this.waitingLabel = 'stopping…';
      this.updateWaiting();
      this.cancelWaiting?.(action === 'cancel-edit');
    } else if (key === '\u001a') {
      this.suspendToShell();
    } else if (key === '\r') {
      const continued = this.waitingSubmit ? backslashNewline(this.waitingDraft, this.waitingCursor) : undefined;
      if (continued) {
        this.waitingDraft = continued.value;
        this.waitingCursor = continued.cursor;
        this.updateWaiting();
        return;
      }
      const text = this.waitingDraft.trim();
      if (!text || !this.waitingSubmit) return;
      // A slash line is ClikCode's own command and never text for the model.
      // Handed to the caller to route (see waiting-slash.ts and slash/queue.ts);
      // a line the router decides is really conversation comes back 'queued'.
      const asCommand = Boolean(commandLineTypedDuringTurn(text)) && Boolean(this.waitingCommand);
      const submit = asCommand ? this.waitingCommand! : this.waitingSubmit;
      // No selection mid-turn -- the arrows scroll the answer -- so a partly
      // typed value means the best match: `/model op` applies opus.
      const line = asCommand ? completedCommandLine(text, this.paletteCommands) : text;
      this.waitingDraft = '';
      this.waitingCursor = 0;
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
        }
        this.updateWaiting();
      }).catch(() => {
        const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
        if (item) item.state = 'error';
        if (!this.waitingDraft) {
          this.waitingDraft = text;
          this.waitingCursor = text.length;
        }
        this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${text}` : text;
        this.updateWaiting();
      });
      this.waitingSubmissionWrites.add(write);
      void write.finally(() => this.waitingSubmissionWrites.delete(write));
    } else if (this.waitingSubmit) {
      const edited = editWaitingComposer(this.waitingDraft, this.waitingCursor, key);
      if (edited.changed) {
        this.waitingDraft = edited.value;
        this.waitingCursor = edited.cursor;
        this.updateWaiting();
      }
    }
  };
  private readonly onResize = (): void => {
    if (!this.closed) {
      // A resize invalidates the wrapping of the live region only. Rows already
      // in scrollback keep the wrapping they were written with -- exactly as
      // Ink and ratatui behave, and precisely why neither of them re-dumps the
      // transcript on every resize. The live region is redrawn at the new width
      // by the ordinary frame below.
      //
      // The one thing this cannot prove: the region is erased by walking up
      // the number of rows it was written as, and a terminal that reflows on
      // resize (xterm and iTerm do; tmux does not) may since have turned a row
      // wider than the new width into two. Walking up too few rows leaves a
      // stale row above the composer until the region next changes height;
      // walking up more than were written would erase real scrollback. The
      // cosmetic failure is the one to prefer, so the walk is capped at what
      // was written and never guessed upward. Both reference implementations
      // have this same limit, for this same reason.
      this.lastColumns = output.columns || 0;
      this.forgetScreenPosition();
      logCursorEvent(`resize screen=${output.columns}x${output.rows} raw=${terminalModes.rawMode} alternate=${terminalModes.alternateScreen}`);
      // Re-asked here, immediately, before anything is drawn. This is the
      // whole fix for "a swipe scrolls with the keyboard up but not with it
      // hidden": hiding the keyboard resizes the pty, the client reapplies
      // its own defaults across that resize and drops mouse reporting, and
      // nothing turns it back on. A working client's own byte stream shows
      // the same four modes going out after every single resize:
      //
      //     [[resize 63x70]] ?1000h ?1002h ?1003h ?1006h  ?25l ESC[2J ESC[H
      //
      // Idempotent, so a client that never dropped them just sets what is
      // already set.
      if (!SELECTION_MODE.active) output.write(ENABLE_MOUSE_TRACKING);
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
  private repaintAfterResize(): void {
    if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
    this.resizePaintTimer = setTimeout(() => {
      this.resizePaintTimer = undefined;
      if (this.closed || this.suspended) return;
      this.repaint();
    }, RESIZE_SETTLE_MS);
    this.resizePaintTimer.unref();
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
  /** Which screen this frame belongs on.
   *
   * The conversation lives on the main screen, in a scroll region, because
   * that is the only place the TERMINAL owns the transcript -- and a swipe
   * scrolls what the terminal owns, with no bytes sent, whatever the client
   * is doing with its keyboard.
   *
   * A palette or a picker goes to the alternate screen instead. Two reasons,
   * and they point the same way. It is modal, full-screen, transient UI, which
   * is what that screen is for. And a bottom region cannot grow to fit one
   * without pushing rows off the top of the scrolling half, which the terminal
   * cannot give back -- opening and closing a palette ten times walked the
   * conversation fifty rows away. On the alternate screen it costs nothing:
   * the main screen, transcript and all, is exactly as it was when it closes.
   *
   * On the alternate screen it costs nothing: the screen underneath, the
   * conversation and all, is exactly as it was when the overlay closes. */
  /** The alternate screen is not optional, and the old `alternateScreen`
   * field was not a real choice: both construction sites are gated on
   * terminalUiSupported(), which REQUIRES output.isTTY -- the one value the
   * field was computed from. It was always true, so every
   * `if (!this.alternateScreen) return false` was guarding against a
   * line-oriented mode that cannot exist. The invariant is now asserted once
   * in the constructor instead of re-tested at nine call sites, and a non-TTY
   * caller fails loudly there rather than entering a half-working mode. */
  /** The title last given to the terminal, so a repaint does not resend it. */

  constructor() {
    if (!output.isTTY) {
      throw new Error('TerminalHarnessPrompter requires a TTY on stdout; construct it behind terminalUiSupported()');
    }
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
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
      // Asked for: bracketed paste, because pasted text must not be read as
      // keystrokes, and the mouse, because that is how the transcript is read
      // back. Nothing else.
      //
      // Focus reporting (?1004h) and theme notifications (?2031h) used to be
      // asked for here and then thrown away where keys are read -- neither is
      // acted on anywhere. Asking a phone to send two streams of events that
      // are discarded on arrival is waste at best, and at worst it is more
      // state for a client to hold about a session that is already failing to
      // forward the one gesture that matters. The filters that drop them stay,
      // for a terminal that volunteers them unasked.
      // Selection mode means the user asked for the mouse back; taking the
      // screen must not quietly take it again.
      output.write(`${ENABLE_BRACKETED_PASTE}${SELECTION_MODE.active ? '' : OPENING_MOUSE_TRACKING}`);
      terminalModes.bracketedPaste = true;
      terminalModes.wheelReporting = true;
    }
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
  submitted(prompt: string | undefined): void { this.submittedPrompt = prompt; }

  render(session: HarnessSession, account?: string, notice?: string): void {
    if (this.currentSession?.id !== session.id) {
      this.activityEntries = [];
      this.planEntries = [];
      this.panelState = undefined;
      // The previous conversation is scrolled up into scrollback -- preserved,
      // not erased -- so the new one starts on a clean viewport.
      this.emitted.requestReseed();
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
    if (this.waitingLabel && this.currentSession?.id === session.id && !session.pendingTurn
      && (session.messages?.length ?? 0) > this.activityAnchor) {
      this.stopWaiting(false);
    }
    if (!this.waitingLabel) this.waitingSubmissions = [];
    this.currentSession = session;
    this.currentAccount = account;
    this.currentNotice = notice;
    // A render receives authoritative persisted state. Drop the transient
    // stream so the just-saved assistant message is never painted twice --
    // but NOT while a turn is running, where the live answer is the one thing
    // that is not persisted yet. A setting applied mid-turn renders the status
    // line (see harness/output.ts), and clearing here would take the
    // half-written answer off the screen with it.
    if (!this.waitingLabel) {
      if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
      this.responsePaintTimer = undefined;
      this.liveResponse = '';
    }
    // A picker owns the screen while it is open. A setting flipped from inside
    // one renders the status line (harness/output.ts), and painting the
    // composer here would draw it over the list being used; the state is kept
    // and the frame repaints with it when the picker closes.
    if (this.selecting) return;
    this.paint('', [], 0, '› ', 0);
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    // An empty replacement is meaningful when a failed streaming attempt is
    // about to retry on another account. Appends with no content remain a
    // no-op, but replace must clear the obsolete partial response.
    if (!text && mode === 'append') return;
    // The thought led to this text; once the answer is arriving it is stale.
    if (text) this.latestThought = undefined;
    if (mode === 'replace') {
      this.activityEntries = rebaseActivityOffsets(this.activityEntries, this.activityAnchor, this.liveResponse, text);
      this.liveResponse = text;
    } else this.liveResponse += text;
    this.schedulePaint();
  }

  activity(message: string): void {
    const normalized = sanitizeTerminalText(message, { keepSgr: true, singleLine: true }).trim();
    const last = this.activityEntries[this.activityEntries.length - 1];
    if (!normalized || last?.lines[last.lines.length - 1] === normalized) return;
    this.activityEntries = [...this.activityEntries, {
      anchor: this.waitingLabel ? this.activityAnchor : this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0,
      ...(this.waitingLabel ? { responseOffset: this.liveResponse.length } : {}),
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

  activityEvent(event: HarnessActivityEvent): void {
    if (event.kind === 'thinking') {
      // Collapsed to the most recent thought, on one live row, never in the
      // transcript. A bare "thinking" label says nothing the spinner does not.
      const thought = sanitizeTerminalText(event.label, { singleLine: true }).replace(/\s+/g, ' ').trim();
      this.latestThought = thought && thought.toLowerCase() !== 'thinking' ? thought : this.latestThought;
    } else if (event.kind === 'tool-start') this.latestThought = undefined;
    const anchor = this.waitingLabel ? this.activityAnchor : this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0;
    const responseOffset = this.waitingLabel ? this.liveResponse.length : undefined;
    this.activityEntries = upsertActivityEvent(this.activityEntries, anchor, responseOffset, event, ++this.timelineSequence);
    const lifecycle = activityLifecyclePhase(this.activeTools, event);
    this.activeTools = lifecycle.activeTools;
    this.waitingCategory = lifecycle.category;
    this.phase(lifecycle.phase);
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

  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
    onCommand?: (text: string) => Promise<LiveTurnInputResult>,
  ): void {
    this.stopWaiting(false);
    // A new turn is the reader rejoining the conversation.
    this.alternateScrollback = 0;
    this.liveResponse = '';
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
    this.waitingLabel = message;
    this.cancelWaiting = onCancel;
    this.waitingSubmit = onSubmit;
    this.waitingCommand = onCommand;
    this.waitingDraft = '';
    this.waitingCursor = 0;
    this.waitingSubmissions = [];
    this.activeTools.clear();
    this.waitingCategory = undefined;
    this.waitingCancelled = false;
    this.waitingFrame = 0;
    this.waitingStartedAt = Date.now();
    this.turnUsage = undefined;
    this.latestThought = undefined;
    this.panelState = undefined;
    // Whatever the previous turn retired belongs to the terminal now. This one
    // starts owing everything it produces, and nothing from before it.
    this.turnTranscript.reset();
    this.emitted.liveAnswerSettled();
    this.emitted.turnSequenceFloor = this.timelineSequence;
    this.streamingBlocks = createStreamingBlockParser();
    if (input.isTTY) {
      const listen = (): void => {
        setTerminalRawMode(true);
        input.resume();
        output.write(enterInputModes());
        this.stopWaitingInput = listenForTerminalKeys(this.onWaitingKey);
      };
      listen();
      this.resumeInput = () => { this.stopWaitingInput?.(); listen(); };
    }
    this.paint('', [], 0, '› ', 0);
    this.waitingTimer = setInterval(() => {
      this.waitingFrame++;
      this.updateWaiting();
    }, this.reducedMotion ? 1000 : 300);
    this.waitingTimer.unref();
  }

  /** The caller uses these only after an interrupted turn: before any output,
   * Escape restores the submitted text; after output begins, the partial turn
   * is persisted instead. */
  restoreDraft(value: string): void { this.queuedDraft = value; }
  async flushWaitingSubmissions(): Promise<void> {
    await Promise.allSettled([...this.waitingSubmissionWrites]);
  }
  liveResponseText(): string { return this.liveResponse; }
  turnOutputStarted(): boolean {
    return Boolean(this.liveResponse || this.activityEntries.some((entry) =>
      entry.anchor === this.activityAnchor && entry.responseOffset !== undefined
      && (entry.event?.kind === 'tool-start' || entry.event?.kind === 'tool-done' || entry.event?.kind === 'tool-error')));
  }

  stopWaiting(refresh = true): void {
    if (this.waitingTimer) clearInterval(this.waitingTimer);
    this.waitingTimer = undefined;
    this.stopWaitingInput?.();
    this.stopWaitingInput = undefined;
    if (this.waitingLabel) this.resumeInput = undefined;
    this.cancelWaiting = undefined;
    this.waitingSubmit = undefined;
    this.waitingCommand = undefined;
    this.waitingCancelled = false;
    this.settleApprovals();
    this.waitingLabel = '';
    this.latestThought = undefined;
    // Anything typed during the turn and not submitted is still the user's
    // text. It lives in waitingDraft while the turn runs, and the composer
    // that opens afterwards reads queuedDraft -- so without this handoff a
    // message typed while the answer streamed was simply gone the moment the
    // turn finished. Appended rather than assigned: a queued submission may
    // already be waiting there, and neither should overwrite the other.
    if (this.waitingDraft.trim()) {
      this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${this.waitingDraft}` : this.waitingDraft;
    }
    this.waitingDraft = '';
    this.waitingCursor = 0;
    // The turn is over: its prompt is a real message now, and holding the
    // client's copy any longer would draw it twice.
    this.submittedPrompt = undefined;
    if (refresh && !this.closed) this.repaint({ keepPalette: false });
  }

  phase(message: string): void {
    if (!this.waitingLabel || this.waitingCancelled || this.waitingLabel === message) return;
    // The band says "waiting for approval" while one is up; remember the phase
    // for when it is answered instead of replacing that.
    if (this.pendingApproval) { this.approvalRestoreLabel = message; return; }
    this.waitingLabel = message;
    this.updateWaiting();
  }

  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'> {
    return new Promise<boolean | 'always'>((resolveApproval) => {
      if (!this.pendingApproval) this.approvalRestoreLabel = this.waitingLabel;
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
    const next = this.approvalQueue.shift();
    if (!next) return false;
    // Each approval gets its own guard window and its own focus requirement:
    // answering the first of two must not let the same keypress, or the next
    // character of a sentence, answer the second.
    this.pendingApproval = { ...next, shownAt: Date.now(), needsFocus: this.waitingDraft.length > 0, focused: false };
    this.waitingLabel = 'waiting for approval';
    if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
    // Repaint when the guard lifts so the answer row visibly becomes live.
    this.approvalGuardTimer = setTimeout(() => { this.approvalGuardTimer = undefined; this.updateWaiting(); }, APPROVAL_GUARD_MS);
    this.approvalGuardTimer.unref();
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
    for (const item of outstanding) item?.resolve(false);
  }

  /** Optional: token counts for the turn in flight, shown beside the elapsed
   * time. Cleared by the next startWaiting(). */
  setTurnUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.turnUsage = { ...this.turnUsage, ...usage };
    this.updateWaiting();
  }

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
    const model = nativeModelLabel(harness?.command, rawModel);
    const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
    // The title used to share this line with provider/model/directory, which
    // meant a long title truncated whichever of those came after it — the
    // exact information you'd want intact regardless of how long the title
    // is. It gets its own line now (see titleText below).
    return [provider, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  /** The only other place a chat's title ever appeared was a transient line in
   * the /resume picker itself — once you were actually inside a resumed
   * conversation there was nothing on screen confirming which one, so
   * switching looked like it hadn't done anything even when the transcript
   * above had in fact changed. Right-aligned on its own line so it never
   * competes with statusText()'s provider/model/directory for space. */
  private titleText(): string | undefined {
    return this.currentSession?.name || undefined;
  }

  /** Elapsed time alongside the label -- matching a native CLI's own "Cogitated
   * for 5m 31s" style -- so a long turn reads as "still working, N seconds in"
   * rather than the same static label sitting there with no sense of how long
   * it's actually been (only the spinner glyph itself changing periodically). */
  private waitingLine(): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.waitingStartedAt) / 1000));
    const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
    // "steer or queue" over-promised: only the codex app-server transport can
    // interrupt a running turn, and every other harness silently queues for the
    // next one. The per-submission row below the composer already reports which
    // of the two actually happened, so the invitation just says what is always
    // true and lets the outcome speak for itself.
    const tokens = formatTurnUsage(this.turnUsage);
    const label = `${this.waitingLabel} (${elapsed}${tokens ? ` · ${tokens}` : ''})`
      + `${this.cancelWaiting && !this.pendingApproval ? ' · esc to interrupt' : ''}`
      + `${this.waitingSubmit ? ' · type and press Enter to send' : ''}`;
    // What the agent is doing is essential and stays at full contrast; only the
    // counters and key hints after it are dimmed.
    const split = label.indexOf(' (');
    // One spinner, one motion, for every harness and every tool -- the shape
    // is the standard, the colour is what kind of work is running.
    const spinner = waitingSpinnerGlyph(this.reducedMotion ? 0 : this.waitingFrame);
    const tinted = this.waitingCategory ? TOOL_CATEGORY_STYLE[this.waitingCategory].paint(spinner) : chalk.cyanBright(spinner);
    // The same glyph the settled row will carry, so a tool looks like itself
    // before and after it finishes rather than changing shape on completion.
    const mark = this.waitingCategory
      ? ` ${TOOL_CATEGORY_STYLE[this.waitingCategory].paint(TOOL_CATEGORY_STYLE[this.waitingCategory].glyph)}`
      : '';
    return `${tinted}${mark}  ${label.slice(0, split)}${chalk.dim(label.slice(split))}`;
  }

  private updateWaiting(): void {
    if (!this.waitingLabel || this.closed || this.selecting || this.paletteActive) return;
    this.schedulePaint();
  }

  /** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
   * all arrive in the same few milliseconds. One shared scheduler collapses
   * those signals into a single atomic frame instead of queueing competing
   * terminal writes that briefly expose half-updated cursor/footer state. */
  private schedulePaint(delay = 32): void {
    if (this.responsePaintTimer || this.closed || this.suspended || this.selecting || this.paletteActive) return;
    this.responsePaintTimer = setTimeout(() => {
      this.responsePaintTimer = undefined;
      if (!this.closed && !this.selecting && !this.paletteActive) {
        if (this.waitingLabel) this.paintWaiting();
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
  private paintWaiting(): void {
    const found = this.waitingCommand ? commandPaletteMatches(this.waitingDraft, this.paletteCommands) : [];
    // Commands while nothing has been typed past the name; the argument's
    // own values once it has. A bare hint row is not worth the space mid-turn.
    const matches = !this.waitingDraft.includes(' ') || found[0]?.completes ? found : [];
    if (!matches.length) {
      this.paint(this.waitingDraft, [], 0, '› ', this.waitingCursor);
      return;
    }
    this.paint(this.waitingDraft, matches, 0, '› ', this.waitingCursor, {
      capacity: Math.min(matches.length, 8) + 2,
      hint: '↵ apply · esc interrupts',
    });
  }

  /** Every update is a complete atomic frame. Partial footer/composer paints
   * were smaller, but depended on a particular older frame already being on
   * screen and became invalid when slow terminals dropped intermediate work. */
  /** Repaint with the composer exactly as the last paint left it.
   *
   * This spread appeared nine times, and three of those omitted the palette
   * -- which does not merely go unmentioned, because paint() reads absent as
   * "there is none" and clears the saved one. The flag states which is meant.
   *
   * The rule the nine call sites follow, which is worth writing down because
   * the omission made it invisible:
   *
   *  - KEEP the palette for an incremental repaint of an edit still in
   *    progress -- a resize, a coalesced paint, a scroll, a reading-direction
   *    change. The user is mid-`/command`; taking their palette away as the
   *    terminal reflows would be the bug.
   *  - CLEAR it where the composer is being re-established fresh and a stale
   *    palette would be wrong: a panel opening (paint() draws a panel only
   *    when no palette is up, so they are mutually exclusive), a turn ending,
   *    and resume() after a vendor has had the TTY. In all three the palette
   *    belongs to a command that has already run.
   *
   * resume() looked like an oversight next to the six that keep it, and it is
   * not: the composer it repaints is a new one. */
  private repaint(options: { keepPalette: boolean } = { keepPalette: true }): void {
    if (options.keepPalette) {
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
      return;
    }
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  private paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: { capacity?: number; hint?: string; hideCursor?: boolean }): void {
    const session = this.currentSession;
    if (!session || this.suspended) return;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.draft = composer;
    this.draftOptions = options;
    this.draftSelected = selected;
    this.draftPrompt = prompt;
    this.draftCursor = cursor;
    this.draftPalette = palette ? { capacity: palette.capacity, hint: palette.hint, hideCursor: palette.hideCursor } : undefined;
    // The last column is never printed in. DEC autowrap is off for this whole
    // frame (the `\u001b[?7l` at the top of it), which makes filling it safe
    // on a terminal that honours that -- but several mobile SSH clients, and
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
    const rule = '─'.repeat(rowWidth);
    const stableMessages = session.messages ?? [];
    const pending = this.waitingLabel ? session.pendingTurn : undefined;
    const pendingPrompt = pendingPromptText({
      ...(pending?.prompt ? { durable: pending.prompt } : {}),
      ...(this.submittedPrompt ? { sticky: this.submittedPrompt } : {}),
      lastMessage: stableMessages[stableMessages.length - 1],
    });
    const persistedMessages = pendingPrompt
      ? [...stableMessages, { role: 'user' as const, content: pendingPrompt }]
      : sessionTranscriptMessages(session);
    // Tool events often arrive before the first prose token. They still belong
    // to the in-flight assistant message. Render an empty temporary assistant
    // anchor immediately; otherwise the tools remain invisible and then all
    // appear at once when the first sentence arrives.
    const settledMessage = pendingPrompt ? undefined : persistedMessages[persistedMessages.length - 1];
    const hasTransientAssistant = transientAssistantRequired(
      this.liveResponse, Boolean(this.waitingLabel), persistedMessages.length, this.activityEntries,
      settledMessage?.role === 'assistant' ? settledMessage.content : undefined,
    ) || Boolean(pending?.steers?.length);
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
    const queuedMessages = [
      // A queued COMMAND is not a message and gets no row: it runs when the
      // turn ends and shows whatever it shows then.
      ...storedQueued.filter((item) => item.kind !== 'command')
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: 'queued' as const })),
      ...this.waitingSubmissions.filter((item) => item.state !== 'steered' && !storedCopy(item))
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state })),
    ];
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
    const notice = this.transientNotice ?? this.currentNotice;
    const budget = frameRowBudget({
      targetHeight, waiting: Boolean(this.waitingLabel), notice: Boolean(notice), requestedPaletteCapacity,
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
        needsFocus: approval.needsFocus, focused: approval.focused, queued: this.approvalQueue.length,
      })
      : [];
    let liveBandBudget = Math.max(0, optionalRows - paletteRows - approvalRows.length - 2);
    const thoughtRows = this.waitingLabel && this.latestThought && !approval && liveBandBudget > 0
      ? [`  ${chalk.dim(chalk.italic(visibleSlice(`✻ ${this.latestThought}`, Math.max(1, inner))))}`] : [];
    liveBandBudget -= thoughtRows.length;
    const planRows = paletteRows || this.selecting ? [] : planBlockRows(this.planEntries, width, liveBandBudget);
    liveBandBudget -= planRows.length;
    const panelRows: string[] = [];
    const panel = this.panelState;
    if (panel && !paletteRows && !approval && !this.selecting && liveBandBudget >= 3) {
      const wrapped = panel.lines.flatMap((line) => (terminalCellWidth(line) <= inner ? [line] : wrapCodeLine(line, inner)));
      const page = Math.max(1, Math.min(wrapped.length, liveBandBudget - 2, Math.max(3, targetHeight - 10)));
      panel.page = page;
      panel.total = wrapped.length;
      panel.offset = Math.max(0, Math.min(panel.offset, wrapped.length - page));
      const scrollable = wrapped.length > page;
      const position = scrollable ? `${panel.offset + 1}-${panel.offset + page} of ${wrapped.length} · ↑↓ PgUp/PgDn scroll · ` : '';
      panelRows.push(
        `  ${chalk.bold(visibleSlice(panel.title, inner))}`,
        ...wrapped.slice(panel.offset, panel.offset + page).map((line) => `  ${line}`),
        `  ${chalk.dim(visibleSlice(`${position}q/Esc/Enter close`, inner))}`,
      );
    }
    const maxComposerRows = Math.max(
      1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - approvalRows.length - thoughtRows.length - planRows.length - panelRows.length,
    );
    const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
    // -------------------------------------------------------------------
    // The append-only transcript. A finished row is handed to the terminal's
    // own scrollback exactly once and is never addressed again; only the live
    // region below it -- the block still receiving tokens, queued turns and
    // the footer -- is erased and redrawn. Nothing here rebuilds the
    // conversation to work out which prefix is safe to promote. TurnTranscript
    // decides what can no longer change, and that is the whole decision.
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
    const messageRows = (content: string, marker: string): string[] =>
      renderMessageBlocks(splitIntoBlocks(sanitizeTerminalText(content)), marker, conversationInner);
    /** Activity that belongs between two messages rather than inside a turn.
     * Retired once, by identity rather than by text -- two rows that say the
     * same thing are still two rows -- and an entry that arrives after its
     * anchor has been passed is appended where it lands, which is the only
     * thing an append-only transcript can do with it. */
    const standaloneActivity = (anchor: number): string[] => {
      const rows: string[] = [];
      // Folded first: six reads in a row become one row, and the answer they
      // were serving stays on screen.
      for (const entry of collapseToolRuns(this.activityEntries)) {
        if (entry.anchor !== anchor || entry.responseOffset !== undefined) continue;
        const id = entry.sequence;
        if (!this.emitted.claimActivity(id)) continue;
        rows.push(...activityRows(entry.lines, entry.event?.category));
      }
      return rows;
    };
    /** The in-flight turn's tools and steering messages, as rows that settle.
     * A running tool is reported in the waiting band ("running <label>") and
     * nowhere else: its row is still mutable -- completion rewrites it with the
     * output preview -- and a mutable row can never enter scrollback. At the
     * end of the turn a tool that never reported completion settles anyway,
     * rather than being lost or holding the region open forever. */
    const turnTools = (ended: boolean): SettlingTool[] => {
      const tools: SettlingTool[] = this.activityEntries
        // An anchor is reused: the next turn's assistant occupies the same
        // index when the previous one was never persisted. The turn that
        // produced an entry is what decides whether it belongs to this one.
        .filter((entry) => entry.anchor === this.activityAnchor && entry.responseOffset !== undefined
          && (entry.sequence ?? 0) > this.emitted.turnSequenceFloor)
        .filter((entry) => ended || entry.event?.kind !== 'tool-start')
        .map((entry) => ({
          id: entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`,
          done: true, responseOffset: entry.responseOffset, lines: activityRows(entry.lines, entry.event?.category),
        }));
      // One row on each side, matching every other message: a steer is a
      // message the user wrote mid-answer.
      const steerRows = (text: string): string[] => [
        '', '', ...messageRows(text, userMarker), `  ${chalk.dim('↳ steered into active turn')}`, '',
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

    if (this.emitted.pendingReseed() === 'scroll-away') {
      finished.push(...Array.from({ length: targetHeight }, () => ''));
      this.lastFinishedRow = '';
    }
    if (this.emitted.pendingReseed()) {
      // The first frame of the process, or of a newly opened session, writes
      // the conversation once -- ALL of it. Everything already in scrollback
      // (the shell's own output, the previous conversation) stays where it is.
      //
      // This wrote only the last forty messages, which is why a chat opened
      // from disk could not be scrolled back through: the rows were never
      // written, so there was nothing above the fold to find. On the main
      // screen the terminal's scrollback is where a conversation lives, and a
      // window here truncated it at the one moment it is filled.
      this.emitted.reseeded();
      this.turnTranscript.reset();
    }
    // Where this list carries on from, whether the pending turn is already
    // in it, and where the live answer landed. All three are stated -- with
    // the failures each one prevents -- in render/transcript-seam.ts.
    const resume = this.emitted.resume(persistedMessages);
    const { firstUnwritten, materializedPendingTurn } = resume;
    // Cleared below once the live answer has been consumed, so it stays a let.
    let liveAssistant = resume.liveAssistant;

    emit(standaloneActivity(firstUnwritten));
    for (let index = firstUnwritten; index < persistedMessages.length; index += 1) {
      const message = persistedMessages[index]!;
      if (index === liveAssistant && message.role === 'assistant') {
        // The answer that just streamed. Its rows are already in scrollback and
        // the transcript knows exactly which blocks it still owes, so a
        // persisted copy that runs longer than what streamed -- a re-derived
        // answer, an interrupted turn -- contributes only its tail, and one
        // identical to what streamed contributes nothing at all.
        emit(this.turnTranscript.advance({
          content: sanitizeTerminalText(message.content), tools: turnTools(true), turnEnded: true, renderBlocks,
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
        emit(messageRows(message.content, message.role === 'assistant' ? '·' : userMarker));
      }
      if (index === liveAssistant) {
        this.emitted.liveAnswerSettled();
        liveAssistant = undefined;
        this.turnTranscript.reset();
      }
      this.emitted.wrote(message);
      emit(['']);
      emit(standaloneActivity(index + 1));
    }
    this.emitted.settle(persistedMessages.length);

    const liveConversation: string[] = [];
    if (hasTransientAssistant) {
      this.emitted.liveAssistantIndex = persistedMessages.length;
      const content = sanitizeTerminalText(this.liveResponse);
      const step = this.turnTranscript.advance({
        content,
        // The live answer is lexed from its last blank-line boundary rather
        // than re-parsed from the top on every delta.
        blocks: this.streamingBlocks(content),
        tools: turnTools(!this.waitingLabel),
        turnEnded: !this.waitingLabel,
        renderBlocks,
        renderLive,
      });
      emit(step.finished);
      liveConversation.push(...step.live);
    }
    for (const [queueIndex, message] of queuedMessages.entries()) {
      // Provisional, and so never retired: a queued turn becomes a real user
      // message the moment it is sent, and would then be written a second time.
      const status = message.queueState === 'steered' ? 'steered into active turn'
        : message.queueState === 'sending' ? 'submitting…'
          : message.queueState === 'error' ? 'not sent · restored for editing' : 'queued for next turn';
      // One row, the same separator the transcript gives every other message:
      // a message submitted mid-turn is still a message the user wrote.
      // The speaker changes once, where the queue begins: two rows there, the
      // same break a settled prompt gets. Between queued messages it is one --
      // they are a list of things the same person wrote, not a new speaker
      // each time.
      liveConversation.push(...(queueIndex === 0 ? ['', ''] : ['']),
        ...messageRows(message.content, userMarker), `  ${chalk.dim(`↳ ${status}`)}`);
    }
    const conversationLines = liveConversationLines(liveConversation, true);
    const meta = this.statusText();
    const footer: string[] = [];
    // The resting composer starts with a clear row, or its rule sits directly
    // on the last line of the answer. While a turn runs the generating band
    // already carries its own blank, budgeted into the height -- adding a
    // second one there would double the gap and push an answer row off.
    if (!this.waitingLabel) footer.push('');
    if (noticeRows && notice) footer.push(`  ${chalk.yellow(visibleSlice(notice, inner))}`);
    if (paletteCapacity) {
      footer.push(rule);
      const visibleRows = paletteCapacity - 2;
      const windowed = paletteDisplayRows(options as readonly PaletteEntry[], selected, visibleRows);
      for (const row of windowed) {
        if ('header' in row) {
          footer.push(`  ${chalk.dim(visibleSlice(`── ${row.header}`, Math.max(1, width - 4)))}`);
          continue;
        }
        const selectedOption = row.index === selected;
        const available = Math.max(1, width - 4);
        const label = visibleSlice(row.option.label, available);
        const remaining = available - terminalCellWidth(label);
        const detail = row.option.detail && remaining > 3 ? visibleSlice(row.option.detail, remaining - 2) : '';
        footer.push(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${detail ? `  ${chalk.dim(detail)}` : ''}`);
      }
      for (let index = windowed.length; index < visibleRows; index++) footer.push('');
      footer.push(`  ${chalk.dim(visibleSlice(palette?.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
    }
    footer.push(...panelRows, ...planRows, ...approvalRows, ...thoughtRows);
    if (waitingRows) {
      // What is running right now, one row each, directly above the band.
      //
      // Not in the conversation: a row there is anchored at the offset where
      // the tool STARTED, which pins every later paragraph into the repainted
      // region and parks the call above the composer for the whole turn --
      // a regression the live-tools test covers, and caught. The
      // footer has no anchor, so this costs nothing structurally.
      //
      // The band below says only what KIND of work it is; the label lives
      // here, where there is room for it.
      for (const tool of this.activeTools.values()) {
        const style = tool.category ? TOOL_CATEGORY_STYLE[tool.category] : undefined;
        const mark = style ? `${style.paint(style.glyph)} ` : '';
        footer.push(`  ${mark}${chalk.dim(visibleSlice(tool.label, Math.max(1, inner - 2)))}`);
      }
      footer.push('', `  ${visibleSlice(this.waitingLine(), Math.max(1, inner))}`);
    }
    // When a window is exhausted, the harness-reported reset time sits
    // directly above the usage rule it describes.
    if (this.usageResetLabel) {
      footer.push(`  ${chalk.dim(visibleSlice(this.usageResetLabel, Math.max(1, width - 2)))}`);
    }
    // Usage lives on the upper composer border, mirroring the title on the
    // lower border. Keeping it out of the provider/model/directory row makes
    // the two quota windows easy to scan without adding another footer row.
    // Usage is information, not furniture: it reads by state, so running low
    // is visible without reading the number. The rule itself stays dim.
    footer.push(paintUsageRule(rowWidth, this.usageLabel));
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
    footer.push(paintTitleRule(rowWidth, this.titleText()));
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
    // cursor: see parkCursorAt. The block's last row is the status line, and a
    // caret parked there is the one every report of "the cursor is under the
    // composer" is actually describing.
    const cursorRow = Math.max(0, liveConversationRows + composerStart + composerRows.cursorRow - overflow);
    const cursorColumn = 3 + terminalCellWidth(prompt) + composerRows.cursorWidth;
    this.renderFrame(finished, live, cursorRow, cursorColumn, Boolean(palette?.hideCursor));
  }

  /** One append-only frame. `finished` rows are handed to the terminal's own
   * scrollback -- written once, never addressed again -- and only the live
   * region below them is erased and redrawn. */
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
    // Frames that coalesce while a write drains accumulate their finished rows
    // instead of replacing them. A live row dropped here is drawn again by the
    // frame that replaces it; a retired row would simply be lost.
    this.pendingFinished.push(...finished.map(safeRow));
    this.pendingLive = { live: live.map(safeRow), cursorRow, cursorColumn, hideCursor };
    if (!this.frameInFlight) this.flushFrame();
  }

  private flushFrame(): void {
    if (this.closed || this.suspended) return;
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
      const excess = this.alternateTranscript.length - ALTERNATE_TRANSCRIPT_ROWS;
      if (excess > 0) this.alternateTranscript.splice(0, excess);
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
    const furthest = Math.max(0, this.alternateTranscript.length - above);
    this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
    const scrolled = this.alternateScrollback;
    const rows = scrolled > 0
      ? [
        ...this.alternateTranscript.slice(
          Math.max(0, this.alternateTranscript.length - above - scrolled),
          this.alternateTranscript.length - scrolled,
        ),
        ...live.slice(0, Math.max(0, height - above)),
      ]
      : [...this.alternateTranscript.slice(-above), ...live];
    while (rows.length < height) rows.unshift('');
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
    const shift = full || !scrolling ? 0 : this.scrollShift(rows, above);
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
      if (shift !== 0 && index < above && this.shiftedRow(index, shift) === row) continue;
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
    if (!updates.length && !park) return;
    // A frame that redraws everything clears first, and homes, which is what
    // Claude Code does after a resize on this user's phone:
    //
    //     ?1000h ?1002h ?1003h ?1006h  ?25l ESC[2J ESC[H  ...redraw...
    //
    // Addressed rows would overwrite every cell anyway; the clear costs seven
    // bytes and leaves nothing of the old size behind on a screen that just
    // changed shape.
    const clear = full ? '\u001b[2J\u001b[H' : '';
    const frame = `\u001b[?25l${clear}${updates.join('')}${park}${pending.hideCursor ? '' : '\u001b[?25h'}`;
    this.frameInFlight = true;
    terminalModes.painted = true;
    logCursorEvent(`alternate frame: height=${height} rows=${updates.length}/${rows.length} composer=${composerRow} col=${pending.cursorColumn}`);
    output.write(frame, () => {
      this.frameInFlight = false;
      if (this.pendingLive && !this.closed && !this.suspended) this.flushFrame();
    });
  }

  /** How far the previous screen would have to move to become this one, or
   * zero when it is not a clean shift. Positive means content moved up. */
  private scrollShift(rows: readonly string[], above: number): number {
    const previous = this.alternatePrevious;
    // Only the transcript moves. The live region below it is drawn, not
    // scrolled, so a whole-screen comparison never sees a clean shift.
    if (previous.length !== rows.length || above < 4) return 0;
    // Only when the transcript has actually moved. A keystroke changes one
    // row, and a transcript padded with blank rows matches any shift you care
    // to test -- so without this a keystroke looked like a scroll and redrew
    // the screen, which is the opposite of the point.
    let changed = 0;
    for (let index = 0; index < above; index += 1) if (previous[index] !== rows[index]) changed += 1;
    if (changed * 2 < above) return 0;
    for (let shift = 2; shift < above; shift += 1) {
      let up = true;
      let down = true;
      for (let index = 0; index + shift < above; index += 1) {
        if (up && previous[index + shift] !== rows[index]) up = false;
        if (down && previous[index] !== rows[index + shift]) down = false;
        if (!up && !down) break;
      }
      if (up) return shift;
      if (down) return -shift;
    }
    return 0;
  }

  /** What a row would hold after the shift, so the diff below can skip the
   * rows the terminal has already moved into place. */
  private shiftedRow(index: number, shift: number): string | undefined {
    const source = index + shift;
    return source >= 0 && source < this.alternatePrevious.length ? this.alternatePrevious[source] : undefined;
  }



  /** `hidden` keeps the cursor invisible -- it does not mean the cursor may be
   * left anywhere. A terminal always has one, and a client that draws its own
   * caret regardless of DECTCEM (phone SSH clients do) puts it wherever this
   * code last left it. Parking a "hidden" cursor on the block's last row is
   * therefore a caret sitting on the status line, under the composer, for as
   * long as a turn runs. It is parked on the composer either way; only whether
   * it is shown depends on the frame. */
  private parkCursorAt(row: number, column: number, hidden = false): void {
    if (this.closed || this.suspended) return;
    output.write(`\u001b[${Math.max(1, row)};${Math.max(1, column)}H${hidden ? '' : '\u001b[?25h'}`);
  }

  /** Move the viewport through the transcript. Positive scrolls back, and the
   * conversation is followed again at zero, which every new frame returns to
   * by itself once the reader lets go. Returns whether anything moved, so a
   * key that cannot scroll any further still means something to the caller. */
  scrollTranscript(rows: number): boolean {
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
  queueScroll(rows: number): boolean {
    this.pendingScroll += rows;
    if (inKeyBatch()) { this.drainAtBatchEnd(); return true; }
    this.drainScroll();
    return true;
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
  get scrolledBack(): boolean { return this.alternateScrollback > 0; }

  /** Keys that move the transcript rather than the draft, in the one place
   * both the prompt and the waiting band read them from. Reading back is
   * wanted most while a turn runs -- which is the half that had no scrolling
   * at all, so a page key or a wheel notch reached the draft editor instead.
   * Returns whether the key was spent here. */
  private handleScrollKey(key: string): boolean {
    if (isMouseEvent(key)) {
      // Every mouse report is consumed, wheel or not: a click belongs to the
      // client's own selection, never to the composer.
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
    output.write(
      `${popReadModes()}`
      // Whoever takes the terminal takes the main screen with it: a vendor
      // login prompt drawn on our alternate screen would vanish with it.
      + terminalTeardown(true),
    );
    terminalModes.alternateScreen = false;
    process.once('SIGCONT', this.onContinue);
    process.kill(process.pid, 'SIGTSTP');
  }

  private readonly onContinue = (): void => {
    if (this.closed) return;
    this.suspended = false;
    if (!terminalModes.alternateScreen) {
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
    }
    this.lastColumns = output.columns || 0;
    // The shell printed its own rows while it had the terminal, so the row
    // this block used to start on means nothing now.
    this.forgetScreenPosition();
    this.resumeInput?.();
    if (this.waitingLabel) this.paint(this.waitingDraft, [], 0, '› ', this.waitingCursor);
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
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean },
  ): Promise<string> {
    // Kept for the turn this prompt's answer starts: a turn in flight offers
    // the same commands, and this is where they are known.
    this.paletteCommands = commands;
    if (!input.isTTY) {
      // A single check here used to end the whole session the instant it
      // failed once -- fatal specifically after a long suspend/resume
      // window (a vendor login's own OAuth wait, the one case this
      // codebase has anything that runs for 20+ seconds with the real
      // terminal handed over), where a connection hiccup reconnecting a
      // moment later still read as isTTY=false on the very next check and
      // silently discarded whatever the suspended command was about to
      // save, with no error and no crash log to show for it (this exact
      // path, confirmed live: real OAuth completed, then the whole process
      // was just gone). Retrying briefly gives a transient blip a real
      // chance to resolve before treating the terminal as genuinely closed.
      for (let attempt = 0; attempt < 20 && !input.isTTY; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    }
    return new Promise((resolveQuestion, rejectQuestion) => {
      let value = this.queuedDraft ?? '';
      this.queuedDraft = undefined;
      let cursor = value.length;
      let selected = 0;
      let historyIndex = this.history.length;
      // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
      // footer band a fixed height is what stops the conversation area above it from
      // reflowing (and the cursor from jumping) as the number of matches narrows.
      const paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
      // No .slice(0, 8) here: that used to cap the real match list itself,
      // not just what's visible at once, so typing "/" (matching every
      // command) could never scroll to anything past the 8th regardless of
      // how far down you pressed -- selected's own wraparound never saw
      // past index 7 because options.length itself was capped there. The
      // windowed scroll in paint() below already exists specifically to
      // show a scrollable slice of a longer list; capping the list before
      // it ever got there defeated that.
      const matches = () => commandPaletteMatches(value, commands);
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
        this.paint(value, [], 0, prompt, cursor);
      };
      const finish = (answer: string): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        stopInput();
        output.write(`${popReadModes()}\u001b[?25h`);
        this.resumeInput = undefined;
        this.clearTransientNotice();
        if (answer) this.panelState = undefined;
        if (answer && !answer.startsWith('/') && this.history[this.history.length - 1] !== answer) this.history.push(answer);
        resolveQuestion(answer);
      };
      let finished = false;
      // Opt-in, not a default: this same question() drives the persistent
      // chat composer too, where Esc doing nothing is the existing,
      // intentional behavior (there's nothing to "cancel" mid-draft the way
      // there is for a one-off prompt). Callers that need real cancel
      // semantics -- like the API-key env-var-name prompt, previously
      // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
      // { cancellable: true } and get a real rejection to catch, instead of
      // an empty string indistinguishable from "accepted the default".
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        stopInput();
        output.write(`${popReadModes()}\u001b[?25h`);
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      const handleKey = (key: string): void => {
        const matched = matches();
        // `options` drives selection keys. While an argument is being typed the
        // palette is only a hint -- unless it is listing the argument's own
        // values, which are chosen exactly like commands are.
        const completing = Boolean(matched[0]?.completes);
        const options = value.includes(' ') && !completing ? [] : matched;
        const pasted = pastedText(key);
        if (pasted !== undefined) {
          // Pasted newlines are content, not Enter. Splitting on them is what
          // turned one pasted block into a queue of separate messages.
          value = value.slice(0, cursor) + pasted + value.slice(cursor);
          cursor += pasted.length;
          selected = 0;
          return draw();
        }
        if (key === '\u001a') return this.suspendToShell();
        if (!value && !matched.length && this.panelKey(key)) return draw();
        if (key === '\u0003') {
          // Ctrl+C clears a draft first. Leaving takes a second press, because
          // the same key also interrupts a turn and is pressed by reflex.
          if (value) { value = ''; cursor = 0; selected = 0; historyIndex = this.history.length; return draw(); }
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
          if (completing) return finish(completedCommandLine(value, commands, selected));
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            // What was typed wins when it names a command outright: `/new`
            // must run /new even while a better-ranked row is highlighted.
            const command = exactPaletteCommand(value, commands) ?? options[selected].value;
            // Deliberately NOT cleared here. Blanking the region on submit
            // leaves the screen empty for however long the command takes to
            // produce its first frame, which read as "the composer vanished".
            // The palette rows stay up for the moment in between and are
            // replaced by whatever the command paints next.
            return finish(command);
          }
          return finish(value);
        }
        if (key === '\t' && options.length) {
          // A value fills in as it is, ready to run or to keep editing; a
          // command that takes an argument completes ready for it.
          value = completing ? options[selected].value
            : `${options[selected].value}${options[selected].argHint ? ' ' : ''}`;
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
          // Backing out of the command list clears it; inside an argument the
          // arrow edits, as it does in any line.
          if (options.length && !completing) { value = ''; cursor = 0; selected = 0; }
          else cursor = previousCharacterIndex(value, cursor);
          return draw();
        }
        if (key === '\u001b[C') {
          if (completing && cursor >= value.length) return finish(completedCommandLine(value, commands, selected));
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            // Right Arrow is deliberately identical to Enter, including the
            // decision above not to blank the region while the command runs.
            const command = options[selected].value;
            return finish(command);
          }
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
        // Everything else is text editing, shared with the waiting composer.
        const edited = editComposer(value, cursor, key);
        if (!edited.changed) return;
        if (edited.value !== value) selected = 0;
        value = edited.value;
        cursor = edited.cursor;
        draw();
      };
      let exitArmedAt = 0;
      const listen = (): void => {
        setTerminalRawMode(true);
        input.resume();
        output.write(enterInputModes());
        stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      };
      this.resumeInput = () => { stopInput(); if (!finished) listen(); };
      listen();
      draw();
    });
  }

  /** Provider/model/effort pickers share the same atomic frame and palette
   * layout as slash commands, so the conversation stays visible above them. */
  /** Type-to-filter: a picker with more than a screenful of options (the
   * /resume list, across every ClikCode session plus every discovered vendor
   * chat, easily exceeds 50) was arrow-keys-only with no count, no scroll
   * indicator, and silent wraparound at each end -- a real conversation could
   * sit in the middle of a list that long and be effectively unfindable by
   * scrolling alone. Letters/digits/space now narrow the list live by
   * substring match against label and detail (title, provider, status);
   * arrow keys still navigate whatever is currently visible. This is why the
   * old 'j'/'k'/'q' single-letter aliases are gone: they would collide with
   * typing a real filter query character (searching for "qwen" or "junk"). */
  select<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: {
      onBack?: () => void;
      onEscape?: () => void;
      refreshedOptions?: () => readonly PickerOption<T>[];
      refresh?: Promise<unknown>;
    },
  ): Promise<T | undefined> {
    return runOptionPicker<T>({
      paint: (composer, pickerOptions, selected, prompt, cursor, palette) =>
        this.paint(composer, pickerOptions, selected, prompt, cursor, palette),
      clearFrame: () => this.clearInteractiveFrame(),
      setSelecting: (selecting) => { this.selecting = selecting; },
      select: (subTitle, subOptions, subAction, subSettings) => this.select(subTitle, subOptions, subAction, subSettings),
    }, title, options, onAction, settings);
  }

  close(): void {
    if (this.closed) return;
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
    process.off('SIGWINCH', this.onResize);
    process.off('SIGCONT', this.onContinue);
    process.off('exit', restoreTerminal);
    setTerminalRawMode(false);
    input.pause();
    // On the main screen the conversation stays in the terminal's scrollback
    // where it can still be read and copied, and only this UI's own live
    // region goes; on the alternate screen the whole thing is handed back and
    // the shell's own screen returns untouched. The conversation is on disk
    // either way -- `/resume` reopens it.
    output.write(
      `${popReadModes()}`
      + terminalTeardown(terminalModes.alternateScreen),
    );
    terminalModes.alternateScreen = false;
    terminalModes.painted = false;
    terminalModes.leaveLiveRegion = undefined;
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.pendingLive = undefined;
    this.forgetScreenPosition();
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    setTerminalRawMode(false);
    input.pause();
    // Remove the composer and footer before handing over, so the vendor's
    // output continues directly under the conversation instead of being typed
    // across this UI's status rows.
    output.write(`${popReadModes()}${terminalTeardown(false)}`);
    // Best-effort mitigation, not a confirmed root cause: a vendor login's
    // own paste handling erroring right after handoff is plausibly a race
    // between the terminal actually finishing its mode switch (raw -> cooked,
    // bracketed paste off; this UI never uses the alternate screen) and the
    // child process starting to read --
    // both writes above are fire-and-forget from Node's side, with no way to
    // know when the terminal itself has caught up. A short settle window
    // before the caller spawns anything costs nothing on the success path
    // and closes the gap if that race is real.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
  }

  resume(): void {
    if (this.closed) return;
    // A vendor login can resize a mobile terminal while it owns the TTY.
    // Re-seed the authoritative transcript at the new width when control
    // returns; native scrollback remains available above the refreshed view.
    this.suspended = false;
    if (!terminalModes.alternateScreen) {
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
    }
    this.forgetScreenPosition();
    // Whatever the vendor printed stays in scrollback and the live region
    // simply starts again below it: leaving the alternate screen left nothing
    // UI's own on screen, so the next frame begins wherever the cursor is.
    this.lastColumns = output.columns || 0;
    if (input.isTTY) input.resume();
    this.repaint({ keepPalette: false });
  }
}
