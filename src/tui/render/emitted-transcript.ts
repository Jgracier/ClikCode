/** What has already been written to the terminal's scrollback.
 *
 * The transcript is the terminal's own scrollback, which means every write is
 * irreversible: a row emitted twice cannot be unwritten, and one skipped is
 * gone. Seven fields in prompter.ts carried the rules for that between them,
 * mutated from six places inside a 480-line paint(), and nothing tested any
 * of them -- which is how a message once vanished and how a response once
 * appeared twice.
 *
 * Gathered here so each rule is named, and so they can be exercised without a
 * terminal: this class produces no rows and draws nothing. It only remembers
 * what has been drawn and answers where to carry on from.
 */

import { firstUnwritten, liveAssistantAt, materializedPendingTurn, messageKey, type TranscriptMessage } from './transcript-seam.js';

/** Why the whole conversation is about to be written again. `first` is the
 *  first frame of a process or a newly opened session; `scroll-away` is a
 *  return from scrollback, which needs a blank screen pushed first. */
export type ReseedReason = false | 'first' | 'scroll-away';

export type ResumePoint = {
  /** Index in the given list to start writing at. */
  firstUnwritten: number;
  /** The pending turn is already folded into this list, so the LIVE copies of
   *  its steers are the ones to drop. */
  materializedPendingTurn: boolean;
  /** Where the answer that just streamed actually landed, if one did. */
  liveAssistant?: number;
};

export class EmittedTranscript {
  private messages = 0;
  private lastMessage?: string;
  private readonly activity = new Set<number>();
  private readonly retired = new Set<string>();
  private reseed: ReseedReason = 'first';
  /** Where the live answer sits in the list, while it is still streaming. */
  liveAssistantIndex?: number;
  /** Activity older than this belongs to a previous turn. */
  turnSequenceFloor = 0;

  /** Everything the caller needs to know before it starts writing. */
  resume(persisted: readonly TranscriptMessage[]): ResumePoint {
    const seam = firstUnwritten(persisted, this.messages, this.lastMessage);
    return {
      firstUnwritten: seam,
      materializedPendingTurn: materializedPendingTurn(seam, persisted.length, this.messages),
      liveAssistant: liveAssistantAt(persisted, this.liveAssistantIndex),
    };
  }

  pendingReseed(): ReseedReason {
    return this.reseed;
  }

  /** A return from scrollback rewrites everything; the very first frame does
   *  too, but has nothing above it to clear. */
  requestReseed(everWritten = this.messages > 0): void {
    this.reseed = everWritten ? 'scroll-away' : 'first';
  }

  /** Forget everything written, because it is all about to be written again.
   *  The whole conversation is rewritten, not a window of it: writing only the
   *  last forty messages is why a chat opened from disk could not be scrolled
   *  back through -- the rows were never there to find. */
  reseeded(): void {
    this.messages = 0;
    this.lastMessage = undefined;
    this.activity.clear();
    this.retired.clear();
    this.liveAssistantIndex = undefined;
    this.reseed = false;
  }

  /** One message has been written. */
  wrote(message: TranscriptMessage): void {
    this.lastMessage = messageKey(message);
    if (message.role === 'user') this.retired.add(message.content);
  }

  /** Whether a steer with this text has already gone out as a real message.
   *  Matched by TEXT, which is only safe after the pending turn has been
   *  materialized -- before that the live copy is the only copy. */
  wasRetired(content: string): boolean {
    return this.retired.has(content);
  }

  retiredTexts(): ReadonlySet<string> {
    return this.retired;
  }

  /** Claims one activity row, returning false if it has already been written.
   *  By identity, never by text: two rows that say the same thing are still
   *  two rows. */
  claimActivity(sequence: number | undefined): boolean {
    if (sequence === undefined || this.activity.has(sequence)) return false;
    this.activity.add(sequence);
    return true;
  }

  /** The live answer has been consumed into the persisted list. */
  liveAnswerSettled(): void {
    this.liveAssistantIndex = undefined;
  }

  /** Monotonic on purpose: a row in scrollback cannot be un-emitted, so a
   *  list that comes back SHORTER -- the live form of a turn that
   *  sessionTranscriptMessages had already materialized -- must not lower it,
   *  or the seam walks backwards and rewrites what is already on screen. */
  settle(persistedLength: number): void {
    this.messages = Math.max(this.messages, persistedLength);
  }

  /** Exposed for the one caller that needs the raw count: deciding whether a
   *  reseed has anything above it to clear. */
  writtenCount(): number {
    return this.messages;
  }
}
