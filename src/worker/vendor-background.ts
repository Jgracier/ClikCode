/** A session worker's side of a vendor background turn (see
 * harness/transport/background-turn.ts): work a Codex app-server or an ACP
 * agent does while no ClikCode turn is running -- a turn the vendor started
 * itself, or a shell / sub-agent a finished turn left running.
 *
 * Each one is broadcast to the attached windows like a turn (waiting-start,
 * deltas, activity, approvals, waiting-stop), keeps the worker from idling
 * out while it runs, and is persisted to the conversation when it ends. One
 * at a time, and never beside a user turn: a user turn supersedes it (the
 * transport ends it and hands the vendor to that turn), and one that arrives
 * while a user turn is still finishing starts right after. */
import { mergeBackgroundWork, type BackgroundWork } from '../harness/protocol/background-agents.js';
import { diagnostic, lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import type { BackgroundTurnOutcome, VendorBackgroundTurn } from '../harness/transport/background-turn.js';
import type { BroadcastObserver } from './broadcast-observer.js';
import { TurnRecorder } from '../session/turn-changes.js';
import { stateDirectory } from '../session/store/paths.js';
import { refusalEndingReply } from '../turn/account-evidence.js';
import { quotaRetryHint } from '../turn/failover.js';
import { observeSessionAccount } from '../turn/vendor-process.js';

const BACKGROUND_TURN_LABEL = 'background work';

interface RunnerDependencies {
  sessionId: string;
  observer: BroadcastObserver;
  /** True while a user turn runs (or is being started). */
  userTurnRunning: () => boolean;
  /** Busy state changed: the worker re-evaluates its idle exit. */
  changed: () => void;
  /** The same live turn state history reads: background runs count even when no task level is reported. */
  runningChanged?: (since?: string) => Promise<void> | void;
  /** A retry was parked on the session for after a usage reset (`resumeAt`): the worker's waiter looks at it. */
  resumeParked?: () => void;
}

/** What is sent, once the limit resets, for a notification the usage limit left unanswered. */
export const NOTIFICATION_RETRY_PROMPT = 'A background task finished while your usage limit was reached, so its notification went unanswered. Check what the finished background tasks reported and carry on from there.';

/** A background turn that ended on the vendor's usage-limit refusal ("You've hit your session limit · resets 6:50pm
 * (America/Denver)"): the model's words before it, the refusal on its own, and when the limit lifts. The refusal rides
 * the end of the turn's text because the vendor streams it as a message, so it is cut off the prose it followed
 * (2026-10-30: "...for real.You've hit your session limit" in one assistant message). */
export function splitRefusal(text: string, now: number = Date.now()): { prose: string; refusal: string; resetsAt?: string } | undefined {
  const refusal = refusalEndingReply(text);
  if (!refusal) return undefined;
  const resetsAt = quotaRetryHint(new Error(refusal), now);
  return { prose: text.trimEnd().slice(0, text.trimEnd().length - refusal.length).trimEnd(), refusal, ...(resetsAt ? { resetsAt } : {}) };
}

interface VendorBackgroundRunner {
  /** Register with the persistent transport (runtime.setVendorBackgroundTurnHandler). */
  readonly handle: (turn: VendorBackgroundTurn) => void;
  /** A background turn is running or waiting to. */
  readonly busy: boolean;
  /** Settles once no background record is being written. A user turn awaits
   * it before it reads the conversation, so neither save erases the other. */
  settled(): Promise<void>;
  /** Saves the records of background turns a user turn superseded, now that
   * its own save is done. Resolves to the conversation as saved, if any were. */
  saveSuperseded(): Promise<HarnessSession | undefined>;
  /** Call when a user turn ends: a background turn that arrived meanwhile starts. */
  userTurnEnded(): void;
}

/** What is kept of a background turn: its prose, or -- when it only
 * finished work -- one line naming that work, so the conversation says what
 * happened after the reply. Nothing for a turn that did nothing visible. */
export function backgroundTurnRecord(outcome: BackgroundTurnOutcome, finished: readonly string[]): string | undefined {
  const text = outcome.text.trim();
  if (text) return text;
  if (outcome.ended !== 'completed') return undefined;
  const unique = [...new Set(finished.filter((label) => !/^(?:failed )?tool$/i.test(label.trim())))];
  if (!unique.length) return undefined;
  return `Background work finished: ${unique.slice(0, 8).join('; ')}${unique.length > 8 ? `; and ${unique.length - 8} more` : ''}.`;
}

function appendBackgroundRecord(session: HarnessSession, record: string, now: string): void {
  session.messages = [...(session.messages ?? []), { role: 'assistant', content: record }];
  session.updatedAt = now;
}

export function createVendorBackgroundRunner(deps: RunnerDependencies): VendorBackgroundRunner {
  const waiting: VendorBackgroundTurn[] = [];
  let active: VendorBackgroundTurn | undefined;
  /** Records of background turns a user turn superseded: that turn's
   * checkpoint rewrites the whole transcript as it goes, so one appended
   * beside it was erased. They are saved once it is done (saveSuperseded). */
  const superseded: string[] = [];
  /** Every background save, in order; a user turn waits for it (settled). */
  let saving: Promise<unknown> = Promise.resolve();

  const persist = (records: readonly string[], change?: (session: HarnessSession, now: string) => void): Promise<HarnessSession | undefined> => {
    const write = saving.then(async () => {
      const state = await readState({ transcripts: [deps.sessionId] });
      const session = state.sessions.find((item) => item.id === deps.sessionId);
      if (!session) return undefined;
      const now = new Date().toISOString();
      for (const record of records) appendBackgroundRecord(session, record, now);
      change?.(session, now);
      await writeState(state);
      return session;
    });
    saving = write.catch(quiet('worker/vendor-background'));
    return write;
  };

  /** The account that ran out is marked, so the next turn moves on (as for a refusal said out of turn). */
  const markAccountSpent = async (refusal: string): Promise<void> => {
    const accountId = (await readState({ transcripts: [] })).sessions.find((item) => item.id === deps.sessionId)?.nativeThreadAccountId;
    if (!accountId) return;
    await observeSessionAccount({ sessionId: deps.sessionId, accountId, evidence: { vendorError: true, text: refusal }, source: 'background-turn' });
  };

  const saveSuperseded = (): Promise<HarnessSession | undefined> => {
    if (!superseded.length) return Promise.resolve(undefined);
    return persist(superseded.splice(0)).catch(quiet('worker/vendor-background'));
  };

  const run = async (turn: VendorBackgroundTurn): Promise<void> => {
    active = turn;
    void deps.runningChanged?.(new Date().toISOString());
    lifecycle('worker.background.start', { transport: turn.transport, reason: turn.reason });
    deps.changed();
    const { observer } = deps;
    const finished: string[] = [];
    /** The background level this run has been told so far (the transport sends each kind it names). */
    let level: BackgroundWork | undefined;
    // A turn of its own for /undo: edits a vendor made in the background are
    // not the user turn's before or after it.
    const recorder = new TurnRecorder(BACKGROUND_TURN_LABEL, 'reported');
    recorder.start();
    observer.startTurn(BACKGROUND_TURN_LABEL, undefined, true);
    // The waiting line is this turn's until another turn starts over it.
    const generation = observer.turnGeneration;
    const owned = (): boolean => observer.turnGeneration === generation && !deps.userTurnRunning();
    const sink: HarnessTurnObserver = {
      onResponseDelta: (text, mode) => observer.response(text, mode ?? 'append'),
      onActivity: (event) => {
        if (event.kind === 'tool-done' || event.kind === 'tool-error') finished.push(`${event.kind === 'tool-error' ? 'failed ' : ''}${event.label}`);
        recorder.add(event);
        observer.activityEvent(event);
      },
      onThought: (text, id) => observer.activityEvent({ kind: 'thinking', label: thoughtLabel(text), ...(id ? { id } : {}) }),
      onUsage: (usage) => observer.setTurnUsage(usage),
      onBackgroundWork: (update) => {
        level = mergeBackgroundWork(level, update);
        observer.setBackgroundWork?.(level);
      },
      onPhase: (phase) => observer.phase(phase),
      onPlan: (entries) => observer.setPlan(entries),
      onApproval: async (title, detail, preview, signal, callId) => (await observer.approval(title, detail, preview, undefined, signal, callId)) !== false,
      onNotice: (message) => diagnostic('vendor.notice', message),
      ...(observer.askQuestions ? { onQuestion: (request, signal) => observer.askQuestions!(request, signal) } : {}),
    };
    turn.attach(sink);
    try {
      const outcome = await turn.finished;
      lifecycle('worker.background.end', { ended: outcome.ended });
      // The usage limit ends the turn's text: its own row, and the notification it left unanswered is retried after the reset.
      const refused = splitRefusal(outcome.text);
      const prose = refused ? backgroundTurnRecord({ ...outcome, text: refused.prose }, finished) : backgroundTurnRecord(outcome, finished);
      const refusalRow = refused ? `${refused.refusal}${refused.resetsAt ? ' The notification will be retried after the reset.' : ''}` : undefined;
      const record = prose ?? refusalRow;
      if (refused) {
        lifecycle('worker.background.refused', { refusal: refused.refusal.slice(0, 200), ...(refused.resetsAt ? { resetsAt: refused.resetsAt } : {}) });
        if (owned()) observer.response(refused.prose, 'replace');
      }
      // Only background work that left something in the conversation is a
      // turn there to undo.
      if (record) await recorder.finish(stateDirectory(), deps.sessionId).catch(quiet('worker/vendor-background'));
      const records = [...(prose ? [prose] : []), ...(refusalRow ? [refusalRow] : [])];
      const park = refused?.resetsAt ? (session: HarnessSession, now: string): void => {
        // One parked turn at a time: a wait already on the session is kept, and sends for both.
        session.resumeAt ??= { at: refused.resetsAt!, prompt: NOTIFICATION_RETRY_PROMPT, setAt: now };
      } : undefined;
      if (!owned()) {
        // A user turn superseded this one: it owns the windows' waiting line,
        // and the conversation until it is saved.
        superseded.push(...records);
        if (park) void persist([], park).then(() => deps.resumeParked?.()).catch(quiet('worker/vendor-background'));
        if (refused) void markAccountSpent(refused.refusal);
        return;
      }
      const session = records.length || park ? await persist(records, park).catch(quiet('worker/vendor-background')) : undefined;
      if (park) deps.resumeParked?.();
      if (refused) void markAccountSpent(refused.refusal);
      // Still this turn's to end: a user turn may have started (and even
      // finished) while that was saved -- and the waiting-stop belongs to
      // whatever turn is showing now, not to this one.
      if (observer.turnGeneration !== generation) return;
      observer.endTurn(session);
    } finally {
      active = undefined;
      void deps.runningChanged?.(undefined);
      deps.changed();
      next();
    }
  };

  const next = (): void => {
    if (active || deps.userTurnRunning()) return;
    const turn = waiting.shift();
    if (turn) void run(turn);
  };

  return {
    handle: (turn) => { waiting.push(turn); next(); },
    get busy() { return Boolean(active) || waiting.length > 0; },
    settled: () => saving.then(() => undefined),
    saveSuperseded,
    userTurnEnded: () => {
      // Superseded late -- after the user turn's own save already ran.
      void saveSuperseded();
      next();
    },
  };
}
