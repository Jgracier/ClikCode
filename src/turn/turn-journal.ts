/** Durable turn state, completion, and interrupted-turn recovery. */
import { extractSessionTitle, normalizeSessionTitle } from '../session/title.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { LiveTurnSubmission } from './live-input.js';
import type { TurnRunOptions } from './session-turn.js';
import { readState } from '../session/state/read.js';
import { writeState, writeTranscriptCheckpoint } from '../session/state/write.js';
import { beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer, updatePendingResponse } from './checkpoint.js';

/** Name a chat, once, from a title the model produced.
 *
 * Never from the first message: that is the start of a sentence, not a name.
 * A /rename is the user's and is left alone; everything else is provisional
 * until a real title arrives, and a turn that produces none simply leaves the
 * chat unnamed without requesting another title. */
export async function nameSession(
  session: HarnessSession,
  sources: { title?: string; vendor?: () => Promise<string | undefined> },
): Promise<void> {
  if (session.nameSource === 'user' || session.name) return;
  const raw = sources.title ?? await sources.vendor?.().catch(() => undefined);
  const title = raw ? normalizeSessionTitle(raw) : undefined;
  if (!title) return;
  session.name = title;
  session.nameSource = 'provider';
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
    if (partialResponse) updatePendingResponse(session, partialResponse, 'replace', new Date().toISOString());
    finishPendingTurn(session, partialResponse || undefined, new Date().toISOString());
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
  /** Also told every activity: the turn's record for /undo (session/turn-changes.ts). */
  private recorder: { add(event: HarnessActivityEvent): void } | undefined;

  private constructor(private readonly state: HarnessState, readonly session: HarnessSession) {}

  static async start(
    state: HarnessState, session: HarnessSession, prompt: string, queuedTurnId?: string,
  ): Promise<DurableTurnCheckpoint> {
    // Taking a queued turn off the queue is what claims it. One already gone
    // was run by another submit of the same entry (a second window whose
    // read of the queue predates that run): running it again is the double.
    if (queuedTurnId && !consumeSessionTurn(session, queuedTurnId)) throw queuedTurnAlreadyRunError(queuedTurnId);
    const checkpoint = new DurableTurnCheckpoint(state, session);
    beginPendingTurn(session, prompt, new Date().toISOString());
    await checkpoint.enqueue();
    return checkpoint;
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    updatePendingResponse(this.session, text, mode, new Date().toISOString());
    this.schedule();
  }

  activity(event: HarnessActivityEvent): void {
    this.recorder?.add(event);
    recordPendingActivity(this.session, event, new Date().toISOString());
    this.schedule();
  }

  async queue(submission: LiveTurnSubmission, options: { held?: boolean } = {}): Promise<void> {
    const heldForTurn = options.held ? this.session.pendingTurn?.startedAt : undefined;
    enqueueSessionTurn(this.session, heldForTurn ? { ...submission, heldForTurn } : submission, new Date().toISOString());
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

  /** A steer that timed out was queued, then turned out to have landed after
   * all: drop the queued copy so it is not also sent as the next turn. */
  async unqueue(submission: LiveTurnSubmission): Promise<void> {
    if (consumeSessionTurn(this.session, submission.id)) await this.persistNow();
  }

  async steer(submission: LiveTurnSubmission): Promise<void> {
    recordPendingSteer(
      this.session, submission.text, submission.submittedAt,
      this.session.pendingTurn?.response?.length ?? 0, new Date().toISOString(), submission.id,
    );
    await this.persistNow();
  }

  async persistNow(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }

  async complete(response: string): Promise<void> {
    finishPendingTurn(this.session, response, new Date().toISOString());
    this.dirty = true;
    await this.flush();
    // A turn that streamed perfectly but never reached disk is not a turn
    // that succeeded, and this is the first point with a caller to tell.
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = undefined;
      throw error;
    }
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
  const checkpoint = await DurableTurnCheckpoint.start(state, session, prompt, run.queuedTurnId);
  if (run.recorder) {
    run.recorder.start();
    checkpoint.record(run.recorder);
  }
  run.liveInput?.bindQueue((submission, options) => checkpoint.queue(submission, options));
  run.liveInput?.setLateSteerHandler((submission) => checkpoint.unqueueSoon(submission));
  return checkpoint;
}

/** Apply the successful turn's common state changes before the durable write. */
export async function completeTurnCheckpoint(
  session: HarnessSession, checkpoint: DurableTurnCheckpoint, response: string,
  sources: { title?: string; vendor?: () => Promise<string | undefined> } = {},
): Promise<string> {
  const answer = extractSessionTitle(response);
  session.attachments = [];
  session.shellNotes = [];
  await nameSession(session, { ...sources, title: sources.title ?? answer.title });
  await checkpoint.complete(answer.text);
  return answer.text;
}
