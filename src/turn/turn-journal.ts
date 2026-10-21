/** Durable turn state, completion, and interrupted-turn recovery. */
import { cloneData } from '../session/store/data.js';
import { normalizeSessionTitle, titleFromFirstMessage } from '../session/title.js';
import type { HarnessSession, HarnessState, OpenThought, TurnMark } from '../session/model.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { LiveTurnSubmission } from './live-input.js';
import type { TurnRunOptions } from './session-turn.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState, writeTranscriptCheckpoint } from '../session/state/write.js';
import { beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, failPendingTurn, finishPendingTurn, recordPendingActivity, recordPendingMark, recordPendingSteer, setPendingThought, stopPendingCalls, updatePendingResponse } from './checkpoint.js';
import { MarkSequencer, readTurnMarks } from './turn-marks.js';
import { readTurnActivities } from './turn-activities.js';

/** Name a chat: the vendor's own title when it reports one, else the user's
 * first message. A /rename is the user's and is left alone; a name taken from
 * the first message gives way to the vendor's title once the vendor has one. */
async function nameSession(
  session: HarnessSession,
  sources: { vendor?: () => Promise<string | undefined> },
): Promise<void> {
  if (session.nameSource === 'user') return;
  if (session.nameSource !== 'message' && session.name) return;
  const vendorRaw = await sources.vendor?.().catch(() => undefined);
  const vendorTitle = vendorRaw ? normalizeSessionTitle(vendorRaw) : undefined;
  if (vendorTitle) {
    session.name = vendorTitle;
    session.nameSource = 'provider';
    return;
  }
  if (session.name) return;
  const first = session.messages?.find((message) => message.role === 'user')?.content ?? session.pendingTurn?.prompt;
  const title = first ? titleFromFirstMessage(first) : undefined;
  if (!title) return;
  session.name = title;
  session.nameSource = 'message';
}

function interruptedTurnMessages(
  messages: NonNullable<HarnessSession['messages']>, prompt: string, partialResponse: string, outputStarted: boolean,
): NonNullable<HarnessSession['messages']> {
  if (!outputStarted) return messages;
  const next = [...messages, { role: 'user' as const, content: prompt }];
  if (partialResponse) next.push({ role: 'assistant', content: partialResponse });
  return next;
}

export async function preserveInterruptedTurn(id: string, prompt: string, partialResponse: string, outputStarted: boolean): Promise<void> {
  if (!outputStarted) return;
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (session.pendingTurn?.prompt === prompt) {
    stopPendingCalls(session);
    if (partialResponse) updatePendingResponse(session, partialResponse, 'replace', new Date().toISOString());
    finishPendingTurn(session, partialResponse || undefined, new Date().toISOString(), true);
  } else session.messages = interruptedTurnMessages(session.messages ?? [], prompt, partialResponse, outputStarted);
  session.attachments = [];
  session.shellNotes = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

export async function discardInterruptedTurn(id: string, prompt: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session || !discardPendingTurn(session, prompt)) return;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

/** End the live status after a failed turn without losing the request and
 * partial answer that a later account or provider may continue. */
export async function markFailedTurn(id: string, prompt: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (session && failPendingTurn(session, prompt, new Date().toISOString())) await writeState(state);
}

const QUEUED_TURN_ALREADY_RUN = 'ERR_QUEUED_TURN_ALREADY_RUN';

function queuedTurnAlreadyRunError(queuedTurnId: string): Error {
  return Object.assign(new Error(`queued turn ${queuedTurnId} already ran`), { code: QUEUED_TURN_ALREADY_RUN });
}

/** A queued turn that another submit had already taken off the queue. */
export function isQueuedTurnAlreadyRun(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === QUEUED_TURN_ALREADY_RUN;
}

/** Serializes bounded checkpoint writes for one in-flight turn. Deltas update
 * memory immediately and coalesce into a write of the transcript alone (never
 * the shared index), while start, provider identity changes, completion, and
 * error unwinding force a full durable flush. */
export class DurableTurnCheckpoint {
  private timer: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;
  /** Something on the session's index row changed since the last full write
   *  (touch, unqueueSoon): the debounced write must be a full one. */
  private rowDirty = false;
  /** A debounced write that failed with no caller to reject to. Surfaced by
   *  complete(), so a turn whose conversation was never saved says so. */
  private writeError: Error | undefined;
  private saved = false;
  /** complete() has written the turn's final record. */
  get finished(): boolean { return this.saved; }
  /** Also told every activity: the turn's record for /undo (session/turn-changes.ts). */
  private recorder: { add(event: HarnessActivityEvent): void } | undefined;

  /** The turn's one counter. The worker's observer takes it over when it is
   * bound to this journal (TurnObserver.bindJournal), so a row's number is
   * the same on the screen and in the saved turn. */
  readonly sequencer = new MarkSequencer();

  private constructor(private readonly state: HarnessState, readonly session: HarnessSession) {
    // A journal already holding rows (a turn resumed) goes on after them.
    const pending = session.pendingTurn;
    if (pending) {
      for (const activity of readTurnActivities(pending.activities)) this.sequencer.raiseTo(activity.event.seq ?? 0);
      for (const mark of readTurnMarks(pending.marks)) this.sequencer.raiseTo(mark.seq);
      for (const steer of pending.steers ?? []) this.sequencer.raiseTo(steer.seq ?? 0);
    }
  }

  static async start(
    state: HarnessState, session: HarnessSession, prompt: string, queuedTurnId?: string, automatic?: string,
  ): Promise<DurableTurnCheckpoint> {
    // Taking a queued turn off the queue is what claims it. One already gone
    // was run by another submit of the same entry (a second window whose
    // read of the queue predates that run): running it again is the double.
    const before = queuedTurnId ? { queuedTurns: session.queuedTurns, pendingTurn: cloneData(session.pendingTurn), messages: session.messages, updatedAt: session.updatedAt } : undefined;
    if (queuedTurnId && !consumeSessionTurn(session, queuedTurnId)) throw queuedTurnAlreadyRunError(queuedTurnId);
    const checkpoint = new DurableTurnCheckpoint(state, session);
    beginPendingTurn(session, prompt, new Date().toISOString(), automatic);
    if (!before) {
      // The prompt does not wait for this write. A failed one never stopped the turn (it runs in
      // memory and later writes retry), and the vendor answering is what the journal records --
      // every later write is ordered after this one. Awaited, it was the full transcript rewritten
      // before the prompt went out: 300-800 ms on a 24 MB conversation, under the state lock.
      void checkpoint.enqueue().catch((error: unknown) => checkpoint.persistFailed('start', error));
      return checkpoint;
    }
    try {
      await checkpoint.enqueue();
    } catch (error) {
      // A queued turn is consumed by this very write. If it did not land the
      // entry is still queued on disk, and running anyway would let it run
      // again: the turn does not start, and the entry stays (restored here,
      // so a later write of this state does not drop it) for the caller to
      // report as stalled.
      checkpoint.persistFailed('start', error);
      session.queuedTurns = before.queuedTurns;
      if (!session.queuedTurns) delete session.queuedTurns;
      if (before.pendingTurn) session.pendingTurn = before.pendingTurn; else delete session.pendingTurn;
      if (before.messages) session.messages = before.messages; else delete session.messages;
      session.updatedAt = before.updatedAt;
      throw error;
    }
    return checkpoint;
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    updatePendingResponse(this.session, text, mode, new Date().toISOString());
    this.schedule();
  }

  activity(event: HarnessActivityEvent): void {
    // Numbered here, in place: the observer is shown the same object next.
    const stamped = this.sequencer.stamp(event);
    this.recorder?.add(stamped);
    recordPendingActivity(this.session, stamped, new Date().toISOString());
    this.schedule();
  }

  /** A thought, plan, notice or approval outcome of the turn, from the
   * observer that saw it (TurnMarkJournal). */
  recordMark(mark: TurnMark): void {
    recordPendingMark(this.session, mark, new Date().toISOString());
    this.schedule();
  }

  /** The thought being had; undefined when it settled. */
  setThought(thought: OpenThought | undefined): void {
    setPendingThought(this.session, thought, new Date().toISOString());
    this.schedule();
  }

  /** Where a steer the turn took was placed: what its message and its
   * `submission` answer carry, so every window orders it the same. */
  steerOrder(id: string): { seq: number; responseOffset: number } | undefined {
    const steer = this.session.pendingTurn?.steers?.find((item) => item.id === id);
    return steer?.seq === undefined ? undefined : { seq: steer.seq, responseOffset: steer.responseOffset ?? 0 };
  }

  async queue(submission: LiveTurnSubmission, options: { held?: boolean } = {}): Promise<void> {
    // ClikCode's own note to the model (steerNote) is never a queued turn.
    const { kind, ...rest } = submission;
    if (kind === 'note') return;
    const queued = { ...rest, ...(kind ? { kind } : {}) };
    const heldForTurn = options.held ? this.session.pendingTurn?.startedAt : undefined;
    enqueueSessionTurn(this.session, heldForTurn ? { ...queued, heldForTurn } : queued, new Date().toISOString());
    try {
      await this.persistNow();
    } catch (error) {
      // Queued in memory and then failed to write is the one outcome the
      // composer cannot represent: this call rejecting hands the text back to
      // the draft, while the entry a later flush persists runs the turn
      // anyway -- the message both came back and was sent. Take it out again
      // so the rejection is the truth.
      consumeSessionTurn(this.session, submission.id);
      throw error;
    }
  }

  /** A steer recorded on the turn that never reached the model: taken off the
   * turn and queued as a message for the next one, so transcript and model agree. */
  async requeueSteer(submission: LiveTurnSubmission): Promise<void> {
    const pending = this.session.pendingTurn;
    if (pending?.steers) pending.steers = pending.steers.filter((item) => item.id !== submission.id);
    await this.queue(submission);
  }

  /** A steer that timed out was queued, then turned out to have landed after
   * all: drop the queued copy so it is not also sent as the next turn. */
  async unqueue(submission: LiveTurnSubmission): Promise<void> {
    if (consumeSessionTurn(this.session, submission.id)) await this.persistNow();
  }

  /** Records the steer and drops any queued copy of it in one write, so disk
   * never holds both. Rejects when the turn is already over (nothing to
   * record it on): the broker then queues the message instead. */
  async steer(submission: LiveTurnSubmission): Promise<void> {
    const recorded = recordPendingSteer(
      this.session, submission.text, submission.submittedAt,
      this.session.pendingTurn?.response?.length ?? 0, new Date().toISOString(), submission.id, this.sequencer.take(),
    );
    if (!recorded) throw new Error('turn is finishing');
    consumeSessionTurn(this.session, submission.id);
    await this.persistNow();
  }

  async persistNow(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }

  /** Resolves once steers still in flight have landed or failed (bound by startTurnCheckpoint). */
  settleInput: (() => Promise<void>) | undefined;

  async complete(response: string): Promise<void> {
    // A steer still in flight lands before the final record, or finds the
    // turn over and falls back to the queue; never after, silently.
    if (this.settleInput) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.settleInput(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      if (timer) clearTimeout(timer);
    }
    finishPendingTurn(this.session, response, new Date().toISOString());
    this.dirty = true;
    // The vendor's answer exists and is shown whether or not ClikCode could
    // save it: a failed save is logged and retried by the next write, never
    // allowed to end the turn or hide the reply.
    await this.flush().catch((error: unknown) => this.persistFailed('complete', error));
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = undefined;
      this.persistFailed('complete', error);
    }
    // Straight after the write, in the same turn of the event loop: a snapshot sent from here on that
    // holds the final record knows the turn is over (BroadcastObserver.liveSnapshot).
    this.saved = true;
  }

  /** The turn's state could not be written. Kept dirty so the next write
   *  carries everything, and recorded where a person can find it. */
  private persistFailed(stage: string, error: unknown): void {
    this.dirty = true;
    lifecycle('turn.persist-failed', { stage, session: this.session.id, error: error instanceof Error ? error.message : String(error) });
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) {
      this.dirty = false;
      await this.enqueue();
    } else await this.writes;
  }

  /** Mark the session dirty so the next flush writes it, without awaiting.
   *
   * For callers inside a SYNCHRONOUS callback, which cannot await and have
   * nowhere to report to. They used to write
   * `void checkpoint.persistNow().catch(() => undefined)`, which discarded
   * the failure outright; the debounced write here goes through the same
   * path as every other write, and its failure is remembered rather than
   * dropped (see writeError). */
  record(recorder: { add(event: HarnessActivityEvent): void }): void {
    this.recorder = recorder;
  }

  /** The session's record (not just its answer) changed: a native identity
   *  confirmed, a self-reported model. Written in full, debounced. */
  touch(): void {
    this.schedule(true);
  }

  /** The steer-landed-late case, for a synchronous caller: drop the queued
   *  copy so it is not also sent as the next turn. The state change is
   *  immediate and the write is left to the debounce -- the old
   *  `unqueue(...).catch(() => undefined)` could silently leave the queued
   *  copy in place, which is a duplicate message sent later. */
  unqueueSoon(submission: LiveTurnSubmission): void {
    if (consumeSessionTurn(this.session, submission.id)) this.schedule(true);
  }

  private schedule(row = false): void {
    this.dirty = true;
    if (row) this.rowDirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      // A debounced write has no caller to reject to. Remember the failure so
      // complete() -- which does have one -- reports it, instead of it
      // vanishing into an unhandled rejection.
      void this.enqueue(!this.rowDirty).catch((error: unknown) => { this.writeError = error as Error; });
    }, 250);
  }

  /** `transcriptOnly`: a streamed delta, stored without touching the index
   *  (falls back to a full write when that cannot be done). */
  private enqueue(transcriptOnly = false): Promise<void> {
    // `this.writes.then(...)` off a REJECTED promise never runs its callback,
    // so chaining the next write onto a failed one permanently stopped
    // writeState from ever being called again -- the turn kept streaming and
    // nothing was saved for the rest of the checkpoint's life, with no error
    // anywhere. Proven with a four-write reproduction: two landed.
    //
    // So the chain the NEXT write builds on is always settled, while the
    // promise handed back to THIS caller still carries its own real failure.
    if (!transcriptOnly) this.rowDirty = false;
    const write = this.writes.catch(() => undefined).then(async () => {
      if (transcriptOnly && await writeTranscriptCheckpoint(this.state, this.session.id)) return;
      await writeState(this.state);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

/** Open the turn journal and connect live input before any provider work. */
export async function startTurnCheckpoint(
  state: HarnessState, session: HarnessSession, prompt: string, run: TurnRunOptions,
): Promise<DurableTurnCheckpoint> {
  const checkpoint = await DurableTurnCheckpoint.start(state, session, prompt, run.queuedTurnId, run.automatic);
  // What the observer sees that no driver reports to the journal (a plan, a
  // notice, a thought, an approval's outcome) is kept with the turn.
  run.prompter?.bindJournal?.(checkpoint);
  if (run.recorder) {
    run.recorder.start();
    checkpoint.record(run.recorder);
  }
  if (run.liveInput) { const live = run.liveInput; checkpoint.settleInput = () => live.settled(); }
  run.liveInput?.bindQueue((submission, options) => checkpoint.queue(submission, options));
  run.liveInput?.setLateSteerHandler((submission) => checkpoint.unqueueSoon(submission));
  return checkpoint;
}

/** Apply the successful turn's common state changes before the durable write. */
export async function completeTurnCheckpoint(
  session: HarnessSession, checkpoint: DurableTurnCheckpoint, response: string,
  sources: { vendor?: () => Promise<string | undefined> } = {},
): Promise<string> {
  session.attachments = [];
  session.shellNotes = [];
  // The note a moved chat's first turn carried (session/move.ts) was said.
  delete session.moveNote;
  await nameSession(session, sources);
  await checkpoint.complete(response);
  return response;
}
