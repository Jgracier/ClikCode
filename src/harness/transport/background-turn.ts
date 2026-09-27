/** Work a persistent vendor does when ClikCode has no turn running.
 *
 * A Codex app-server or an ACP agent outlives the turn that started it (as
 * does a Claude Code CLI minding its background tasks, native/held-vendor.ts),
 * and so does what that turn started: a background shell still running when the
 * reply was written, a sub-agent the model did not wait for, a turn the
 * vendor starts by itself. Everything the vendor says about that work used to
 * arrive with no turn to receive it and was dropped, so a tool row stayed
 * "running" forever and a sub-agent's result was never seen.
 *
 * The transport opens one of these instead and hands it to whoever owns the
 * conversation (the session worker). The owner attaches an observer when it
 * is ready -- anything that arrived before is replayed in order -- and
 * persists the outcome once `finished` settles. The transport decides when it
 * is over, from the vendor's own events: the vendor turn completed and the
 * work it was tracking finished. A user turn starting supersedes it. */
import type { HarnessTurnObserver } from '../events/turn-observer.js';

export type BackgroundTurnEnd =
  /** The vendor finished everything it was doing. */
  | 'completed'
  /** A user turn started; it receives whatever the vendor says next. */
  | 'superseded'
  /** The vendor process went away (closed, crashed, restarted). */
  | 'closed'
  /** Safety ceiling: the vendor said nothing for the whole idle budget. */
  | 'idle-timeout';

export interface BackgroundTurnOutcome {
  /** Prose the vendor wrote during the background turn. */
  text: string;
  ended: BackgroundTurnEnd;
}

export interface VendorBackgroundTurn {
  readonly transport: 'codex-app-server' | 'acp' | 'structured-cli';
  /** `vendor-turn`: the vendor began a turn nobody here asked for.
   * `background-work`: a finished turn left work running (a shell, a
   * sub-agent) and its progress is reported here. */
  readonly reason: 'vendor-turn' | 'background-work';
  /** Start receiving. Events that arrived earlier are replayed first. */
  attach(observer: HarnessTurnObserver): void;
  readonly finished: Promise<BackgroundTurnOutcome>;
}

export type VendorBackgroundTurnHandler = (turn: VendorBackgroundTurn) => void;

type Call = (observer: HarnessTurnObserver) => void;

/** The transport's side of a background turn: an observer that buffers until
 * the owner attaches, and a settle-once `finished`. */
export class BackgroundTurnChannel implements VendorBackgroundTurn {
  readonly finished: Promise<BackgroundTurnOutcome>;
  /** What the transport reports into. Never throws into the transport. */
  readonly observer: HarnessTurnObserver;
  private target?: HarnessTurnObserver;
  private readonly queue: Call[] = [];
  private text = '';
  private settled = false;
  /** Approvals asked before the owner attached, refused if it never does. */
  private readonly unanswered = new Set<(accepted: boolean) => void>();
  private resolveFinished!: (outcome: BackgroundTurnOutcome) => void;

  constructor(readonly transport: 'codex-app-server' | 'acp' | 'structured-cli', public reason: 'vendor-turn' | 'background-work') {
    this.finished = new Promise((resolve) => { this.resolveFinished = resolve; });
    const forward = (call: Call): void => {
      if (this.settled) return;
      if (!this.target) { this.queue.push(call); return; }
      try { call(this.target); } catch { /* fail-open-ok: presentation-only consumer */ }
    };
    this.observer = {
      onResponseDelta: (text, mode) => {
        this.text = mode === 'replace' ? text : this.text + text;
        forward((observer) => observer.onResponseDelta?.(text, mode));
      },
      onActivity: (event) => forward((observer) => observer.onActivity?.(event)),
      onThought: (text) => forward((observer) => observer.onThought?.(text)),
      onPlan: (entries, explanation) => forward((observer) => observer.onPlan?.(entries, explanation)),
      onUsage: (usage) => forward((observer) => observer.onUsage?.(usage)),
      onPhase: (phase) => forward((observer) => observer.onPhase?.(phase)),
      onRateLimits: (limits) => forward((observer) => observer.onRateLimits?.(limits)),
      onAvailableCommands: (commands) => forward((observer) => observer.onAvailableCommands?.(commands)),
      // A vendor turn nobody is watching yet still gets its answer once the
      // owner attaches; an owner with no approval surface refuses.
      onApproval: (title, detail) => new Promise<boolean>((resolve) => {
        if (this.settled) return resolve(false);
        const ask: Call = (observer) => {
          const answer = observer.onApproval?.(title, detail);
          if (!answer) return resolve(false);
          answer.then((accepted) => resolve(accepted === true), () => resolve(false));
        };
        if (this.target) return ask(this.target);
        this.unanswered.add(resolve);
        this.queue.push((observer) => { if (this.unanswered.delete(resolve)) ask(observer); });
      }),
    };
  }

  get done(): boolean {
    return this.settled;
  }

  attach(observer: HarnessTurnObserver): void {
    if (this.target) return;
    this.target = observer;
    for (const call of this.queue.splice(0)) {
      try { call(observer); } catch { /* fail-open-ok: presentation-only consumer */ }
    }
  }

  finish(ended: BackgroundTurnEnd): void {
    if (this.settled) return;
    this.settled = true;
    // The queue is kept: an owner that attaches late (it was busy with a user
    // turn) still sees what happened, in order.
    for (const refuse of this.unanswered) refuse(false);
    this.unanswered.clear();
    this.resolveFinished({ text: this.text, ended });
  }
}
