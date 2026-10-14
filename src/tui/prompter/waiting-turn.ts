/** The waiting-turn state machine: starting and stopping a turn or other wait, the tick and clock, queued and steered submissions, and taking a message back. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { editWaitingComposer } from '../composer-edit.js';
import { completedCommandLine } from '../command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { createStreamingBlockParser } from '../render/markdown.js';
import type { LiveTurnInputResult, TakeBackOutcome } from '../../turn/live-input.js';
import type { ToolCategory } from '../../harness/prompter.js';
import { stopEntries } from '../render/activity-log.js';
import { openToolsStatus, joinTurnClock, nextTurnTickMs, pauseTurnClock, resumeTurnClock, startTurnClock, turnAnimating, type TurnWaits } from '../../harness/protocol/activity-view.js';
import { isApprovalWaitPhase, liveTokenTarget, smoothTokens } from '../../harness/protocol/turn-flow.js';
import type { BackgroundWork } from '../../harness/protocol/background-agents.js';
import { enterAgainSends, type WaitingMessage } from '../render/steer-rows.js';
import { commandLineTypedDuringTurn } from '../waiting-slash.js';
import type { TurnUsage } from '../../harness/protocol/turn-usage.js';
import { takeTerminalKeys } from '../input-decoder.js';
import { enterInputModes } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { WaitingTurn } from './state.js';

/** A key typed into the waiting composer. */
export function editTurnDraft(this: TerminalHarnessPrompter, turn: WaitingTurn, key: string): void {
  const edited = editWaitingComposer(turn.draft, turn.cursor, key);
  if (!edited.changed) return;
  turn.draft = edited.value;
  turn.cursor = edited.cursor;
  this.updateWaiting();
}

/** User messages still waiting, oldest first. A command and a background
 *  notice stay in the queue: Esc does not edit them, and Enter again does
 *  not send them. One still being submitted (`sending`) is not waiting. */
export function waitingUserMessages(this: TerminalHarnessPrompter): Array<{ id: string; text: string } & WaitingMessage> {
  const stored = (this.currentSession?.queuedTurns ?? []).filter((item) => item.kind !== 'command' && item.kind !== 'notification' && !this.takingBack.has(item.id));
  const startedAt = this.currentSession?.pendingTurn?.startedAt;
  const unsteered = (id: string): WaitingMessage => (this.waitingSubmissions.some((item) => item.id === id && item.unsteered) ? { unsteered: true } : {});
  return [
    ...stored.map((item) => ({ id: item.id, text: item.text, ...(item.heldForTurn && item.heldForTurn === startedAt ? { held: true } : {}), ...unsteered(item.id) })),
    ...this.waitingSubmissions.filter((item) => item.state === 'queued' && item.id && !this.takingBack.has(item.id) && !stored.some((entry) => entry.id === item.id))
      .map((item) => ({ id: item.id!, text: item.text, ...unsteered(item.id!) })),
  ];
}

/** A message typed during this turn is waiting with its row on screen,
 * and Enter on nothing would put it into the chat (enterAgainSends). One
 * still being submitted has not been answered yet: a quick double Enter
 * must not send it twice. */
export function enterAgainReady(this: TerminalHarnessPrompter): boolean {
  return enterAgainSends(this.waitingUserMessages());
}

/** The turn has an answer: text, or a tool. A thought is not one. */
export function turnHasAnswer(this: TerminalHarnessPrompter): boolean {
  if (this.liveResponse.trim()) return true;
  if (this.activeTools.size > 0) return true;
  return this.activityEntries.some((entry) => entry.event && entry.event.kind !== 'thinking');
}

/** Esc mid-turn: the newest message still waiting -- queued, or held for
 * the turn's next pause -- comes back into the composer, ahead of anything
 * typed, and is gone from the queue. Nothing running is touched. One
 * already on its way into the turn stays where it is. True when there was
 * a message to take, so Esc does not also stop the turn. */
export function takeBackWaiting(this: TerminalHarnessPrompter): boolean {
  const turn = this.turn;
  if (!turn?.takeBack) return false;
  const last = this.waitingUserMessages().at(-1);
  if (!last) return false;
  // Hidden from the moment Esc is pressed until the worker answers
  // (`unqueued`): a snapshot in between does not draw it again, and a second
  // Esc goes on to the next message, or to stop.
  this.takingBack.add(last.id);
  this.updateWaiting();
  void turn.takeBack(last.id).then((outcome) => {
    this.takingBack.delete(last.id);
    if (outcome !== 'removed') { this.updateWaiting(); return; }
    this.waitingSubmissions = this.waitingSubmissions.filter((item) => item.id !== last.id);
    if (this.currentSession?.queuedTurns) this.currentSession.queuedTurns = this.currentSession.queuedTurns.filter((item) => item.id !== last.id);
    if (this.turn) {
      this.turn.draft = this.turn.draft ? `${last.text}\n${this.turn.draft}` : last.text;
      this.turn.cursor = last.text.length;
      this.updateWaiting();
    } else this.queuedDraft = this.queuedDraft ? `${last.text}\n${this.queuedDraft}` : last.text;
  }, () => { this.takingBack.delete(last.id); this.updateWaiting(); });
  return true;
}

/** A message typed during the turn, sent: steered into it or queued
 * behind it (the harness decides; its row says which), or a slash line,
 * which is ClikCode's own command. */
export function submitWaiting(this: TerminalHarnessPrompter, text: string, allowCommand = true): void {
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
  // went. A command does not: it applies (the footer shows the model) or runs
  // when the turn ends, and says nothing of either.
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
      // Its place in the turn is the moment it was acknowledged: rows that
      // began before sort above it, rows that began after sort below
      // (standard 1.5), not where it was typed.
      if (result.disposition === 'steered') item.ack = { sequence: ++this.timelineSequence, responseOffset: this.liveResponse.length };
      if (result.unsteered) item.unsteered = true;
    } else if (asCommand && result.disposition === 'command') {
      this.updateWaiting();
    } else if (asCommand) {
      // The router decided the line was conversation after all: it is a
      // message, with its row, as if it had never looked like a command.
      this.waitingSubmissions.push({
        localId, text, responseOffset: this.liveResponse.length, sequence: ++this.timelineSequence,
        state: result.disposition, id: result.submission.id, ...(result.unsteered ? { unsteered: true } : {}),
      });
    }
    this.updateWaiting();
  }).catch(() => {
    const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
    if (item) item.state = 'error';
    // Restored once: into the running turn's draft (handed to queuedDraft when
    // the turn ends, stopWaiting), else straight to queuedDraft.
    if (this.turn && !this.turn.draft) {
      this.turn.draft = text;
      this.turn.cursor = text.length;
    } else {
      this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${text}` : text;
    }
    this.updateWaiting();
  });
  this.waitingSubmissionWrites.add(write);
  void write.finally(() => this.waitingSubmissionWrites.delete(write));
}

/** What the band showing says, or undefined with no band up: work done
 * on a turn's way in (a local model loading) borrows that band. */
export function waitingLabel(this: TerminalHarnessPrompter): string | undefined {
  return this.turn?.label;
}

/** Progress on a wait already showing ("downloading… 42%"), without
 * restarting it the way startWaiting does. */
export function updateWaitingLabel(this: TerminalHarnessPrompter, message: string): void {
  if (!this.turn) return;
  this.turn.label = message;
  // Progress is activity: a download moving is not a wait gone quiet.
  this.turn.activeAt = Date.now();
  this.updateWaiting();
}

/** A turn this window joined mid-way: count from when it really started,
 * and say what it is running, instead of "thinking (0s)". */
export function joinedWaiting(this: TerminalHarnessPrompter, startedAt?: number, activity?: string): void {
  if (!this.turn) return;
  if (startedAt !== undefined) this.turn.clock = joinTurnClock(this.turn.clock, startedAt);
  if (activity) this.turn.label = activity;
  this.updateWaiting();
}

/** The wait on show is the vendor's own background work, not a turn ClikCode started: Esc leaves it and the
 * work goes on (Ctrl+C is the explicit Stop). Said after startWaiting so that call is the same for every wait. */
export function markVendorWork(this: TerminalHarnessPrompter): void {
  if (this.turn) this.turn.vendorWork = true;
}

export function startWaiting(
  this: TerminalHarnessPrompter,
  message: string,
  onCancel?: (restoreDraft: boolean) => void,
  onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
  onCommand?: (text: string) => Promise<LiveTurnInputResult>,
  onLeave?: () => void,
  onTakeBack?: (id: string) => Promise<TakeBackOutcome>,
  onSendWaiting?: () => void,
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
  if (!rejoined) { this.planEntries = []; this.planStart = undefined; }
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
    label: message, clock: early?.clock ?? startTurnClock(Date.now()),
    activeAt: early?.activeAt ?? Date.now(),
    draft: early?.draft ?? underSignIn ?? '', cursor: early?.cursor ?? underSignIn?.length ?? 0, cancelled: false,
    ...(onCancel ? { cancel: onCancel } : {}), ...(onSubmit ? { submit: onSubmit } : {}),
    ...(onCommand ? { command: onCommand } : {}), ...(onLeave ? { leave: onLeave } : {}),
    ...(onTakeBack ? { takeBack: onTakeBack } : {}),
    ...(onSendWaiting ? { sendWaiting: onSendWaiting } : {}),
  };
  this.turn = turn;
  this.waitingSubmissions = [];
  this.turnSteers.clear();
  this.waitingFrame = 0;
  this.thought = undefined;
  this.thoughtStart = undefined;
  this.panelState = undefined;
  // Whatever the previous turn retired belongs to the terminal now. This one
  // starts owing everything it produces, and nothing from before it.
  if (!rejoined) {
    this.activeTools = new Map();
    this.liveChildren.reset();
    this.agentStarts.clear();
    this.callGrouping.reset();
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
  if (interrupt && onCancel) onCancel(interrupt.restoreDraft);
}

/** A turn is on its way, but what runs it is not answering yet: the first
 * message of a conversation waits on its worker starting, most of 150ms of
 * a node process loading. The message and the spinner are drawn now;
 * startWaiting then takes over the same clock and draft, and an interrupt
 * pressed meanwhile. */
export function turnStarting(this: TerminalHarnessPrompter): void {
  this.startWaiting('thinking');
  if (this.turn) this.turn.early = {};
}

/** What the status line says about the newest open call, if any is open. */
export function toolStatus(this: TerminalHarnessPrompter): { phase: string; category?: ToolCategory } | undefined {
  return this.activeTools.size ? openToolsStatus(this.activeTools) : undefined;
}

/** What the turn waits on besides the model, for the clock's decisions. */
export function turnWaits(this: TerminalHarnessPrompter): TurnWaits {
  return { toolsRunning: this.activeTools.size > 0, approval: this.waitingOnUser() };
}

/** The wait is on the user -- an approval or a sign-in -- not the agent:
 * the band holds still (a ● and no clock) until they act. */
export function waitingOnUser(this: TerminalHarnessPrompter): boolean {
  return Boolean(this.pendingApproval) || this.signingIn;
}

export function scheduleWaitingTick(this: TerminalHarnessPrompter): void {
  const turn = this.turn;
  if (!turn) return;
  if (turn.timer) clearTimeout(turn.timer);
  turn.timer = undefined;
  if (this.closed) return;
  const now = Date.now();
  // Reduced motion never animates: the band ticks for the clock alone.
  this.waitingTickFast = !this.reducedMotion && !turn.cancelled && turnAnimating(this.turnWaits());
  const delay = nextTurnTickMs(turn.clock, now, this.waitingTickFast);
  turn.timer = setTimeout(() => {
    turn.timer = undefined;
    if (this.turn !== turn || this.closed) return;
    if (this.waitingTickFast) this.waitingFrame++;
    this.stepTokens(turn);
    // A tick that changes only the clock costs that one row: the frame
    // writes only the rows that differ from the last.
    this.updateWaiting();
    this.scheduleWaitingTick();
  }, delay);
  turn.timer.unref();
}

/** The status line's token count takes a step toward what the turn has
 * produced (see smoothTokens). Stepped on the tick, not on paint, so the
 * speed does not depend on how many frames were drawn. */
export function stepTokens(this: TerminalHarnessPrompter, turn: WaitingTurn): void {
  // Reasoning is tokens too: the thought being had and the ones settled
  // this turn (a settled mark copy carries its id as its label, not text).
  const thoughtChars = (this.thought?.text.length ?? 0) + this.activityEntries.reduce((sum, entry) => (
    entry.anchor === this.activityAnchor && entry.event?.kind === 'thinking' && entry.event.id === undefined
      ? sum + (entry.event.label?.length ?? 0) : sum), 0);
  const target = liveTokenTarget({ ...(turn.usage ? { usage: turn.usage } : {}), responseChars: this.liveResponse.length, thoughtChars });
  turn.tokens = smoothTokens(turn.tokens ?? 0, target);
}

/** The usage the vendor has reported for the running turn (a running
 * total). It feeds the status line's meter; nothing is drawn for it here. */
export function setTurnUsage(this: TerminalHarnessPrompter, usage: TurnUsage): void {
  if (this.turn) this.turn.usage = usage;
}

/** What the vendor says runs in the background, by kind (standard section
 * 10). Only the terminals are drawn live, as one dim row under the status
 * (`2 background terminals running`); agents and workflows are the end
 * line's, from the saved turn. */
export function setBackgroundWork(this: TerminalHarnessPrompter, work: BackgroundWork | undefined): void {
  const terminals = work?.terminals && work.terminals > 0 ? Math.floor(work.terminals) : 0;
  if (this.backgroundTerminals === terminals) return;
  this.backgroundTerminals = terminals;
  this.schedulePaint();
}

/** The turn waits on the user (an approval, a sign-in): its clock stops,
 * and the time is not the turn going quiet. */
export function pauseClock(this: TerminalHarnessPrompter): void {
  const turn = this.turn;
  if (!turn) return;
  turn.clock = pauseTurnClock(turn.clock, Date.now());
  turn.activeAt = Date.now();
  // Blocked on the user: the frame stops now, not at the next spinner tick.
  if (turn.timer) this.scheduleWaitingTick();
}

/** Whatever the turn waited on the user for has been answered (or the
 * turn ended under it). Another wait on the user still up keeps it held. */
export function resumeClock(this: TerminalHarnessPrompter): void {
  const turn = this.turn;
  if (turn?.clock.pausedAt === undefined || this.waitingOnUser()) return;
  turn.clock = resumeTurnClock(turn.clock, Date.now());
  // Time spent on the user's answer is not the turn going quiet.
  turn.activeAt = Date.now();
  if (turn.timer) this.scheduleWaitingTick();
}

export async function flushWaitingSubmissions(this: TerminalHarnessPrompter): Promise<void> {
  // Bounded: a write that never settles would keep the turn showing as running.
  await Promise.race([
    Promise.allSettled([...this.waitingSubmissionWrites]),
    new Promise<void>((resolve) => { setTimeout(resolve, 10_000).unref(); }),
  ]);
}

/** This window stops following the running turn (← to the board); its
 * worker carries on with it. Not the turn's end, so nothing of it is
 * settled: treated as one, the half-streamed answer went into scrollback
 * cut mid-word, and following the turn again drew it all a second time
 * beneath. See steppedOut. */
export function leaveTurn(this: TerminalHarnessPrompter): void {
  if (this.turn && this.currentSession) {
    this.steppedOut = { sessionId: this.currentSession.id, ...(this.submittedPrompt !== undefined ? { prompt: this.submittedPrompt } : {}), anchor: this.activityAnchor };
  }
  this.stopWaiting();
}

/** The turn showing was stopped elsewhere -- from another window, or its
 * worker is gone -- and ends as one stopped here does: what was still
 * running did not finish, its line says "Stopped", and it is not
 * announced as finished. */
export function turnStopped(this: TerminalHarnessPrompter): void {
  if (this.turn) this.turn.cancelled = true;
}

/** The worker accepted a Stop (`stopping`): the one thing that makes this
 * window say so. */
export function turnStopping(this: TerminalHarnessPrompter, restoreDraft: boolean): void {
  const turn = this.turn;
  if (!turn) return;
  turn.cancelled = true;
  turn.stopLabel = restoreDraft ? 'editing…' : 'stopping…';
  // The spinner and the shimmer hold still from here on.
  this.scheduleWaitingTick();
  this.updateWaiting();
}

/** The worker says a Stop ended nothing (`stop-done`): no longer stopping. */
export function stopSettled(this: TerminalHarnessPrompter): void {
  const turn = this.turn;
  if (!turn?.cancelled) return;
  turn.cancelled = false;
  delete turn.stopLabel;
  this.scheduleWaitingTick();
  this.updateWaiting();
}

/** The turn showing now drives it, if a follow does (see WaitingTurn.ended). */
export function onWaitingEnded(this: TerminalHarnessPrompter, ended: () => void): void {
  if (this.turn) this.turn.ended = ended;
}

export function stopWaiting(this: TerminalHarnessPrompter, refresh = true, why?: string): void {
  const turn = this.turn;
  if (turn) lifecycle('window.turn.end', { cancelled: turn.cancelled, ...(why ? { why } : {}) });
  if (turn?.cancelled && turn.submit && !this.steppedOut) this.markTurnStopped();
  if (turn) {
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = undefined;
    turn.stopInput?.();
    this.resumeInput = undefined;
  }
  // Settled while the turn is still the current one: a "tell it instead"
  // draft goes back into its composer, handed off below.
  this.settleApprovals();
  // A thought still being had when the turn ended stays, settled. Not
  // when stepping out: the turn, and the thought, carry on.
  if (!this.steppedOut) { this.settleThought(); this.settlePlan(); }
  // Stopped: what was still running did not finish. Its row says so, as
  // the worker's saved copy of the turn does (turn-journal.ts).
  if (turn?.cancelled) this.activityEntries = stopEntries(this.activityEntries, (entry) => this.ofThisTurn(entry));
  if (turn?.cancelled) this.childEntries = stopEntries(this.childEntries, () => true);
  // A real turn's end -- one that took messages, not a wait on a download
  // or a shell command -- and not stepping out of it. A stopped turn did
  // not finish, and whoever stopped it knows. (Its closing line is drawn
  // from the saved answer: see turnEndLine.)
  if (turn?.submit && !this.steppedOut && !turn.cancelled) {
    this.notifyIfAway(`${this.currentSession?.name || 'ClikCode'}: the turn has finished`);
  }
  this.turn = undefined;
  this.backgroundTerminals = 0;
  this.thought = undefined;
  this.thoughtStart = undefined;
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

/** The vendor is producing output: a phase reported before it is over. */
export function vendorAnswered(this: TerminalHarnessPrompter): void {
  if (this.reportedPhase === undefined) return;
  if (this.turn?.label === this.reportedPhase) this.turn.label = 'thinking';
  this.reportedPhase = undefined;
}

export function phase(this: TerminalHarnessPrompter, message: string): void {
  const turn = this.turn;
  if (!turn || turn.cancelled || turn.label === message) return;
  // The band says "waiting for approval" while one is up; remember the phase
  // for when it is answered instead of replacing that.
  if (this.pendingApproval) { if (!isApprovalWaitPhase(message)) this.approvalRestoreLabel = message; return; }
  turn.label = message;
  this.reportedPhase = message;
  this.updateWaiting();
}
