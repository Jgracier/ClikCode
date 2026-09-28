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
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { BackgroundTurnOutcome, VendorBackgroundTurn } from '../harness/transport/background-turn.js';
import type { BroadcastObserver } from './broadcast-observer.js';

export const BACKGROUND_TURN_LABEL = 'background work';

interface RunnerDependencies {
  sessionId: string;
  observer: BroadcastObserver;
  /** True while a user turn runs (or is being started). */
  userTurnRunning: () => boolean;
  /** Busy state changed: the worker re-evaluates its idle exit. */
  changed: () => void;
}

export interface VendorBackgroundRunner {
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
  if (!finished.length) return undefined;
  const unique = [...new Set(finished)];
  return `Background work finished: ${unique.slice(0, 8).join('; ')}${unique.length > 8 ? `; and ${unique.length - 8} more` : ''}.`;
}

export function appendBackgroundRecord(session: HarnessSession, record: string, now: string): void {
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

  const persist = (records: readonly string[]): Promise<HarnessSession | undefined> => {
    const write = saving.then(async () => {
      const state = await readState();
      const session = state.sessions.find((item) => item.id === deps.sessionId);
      if (!session) return undefined;
      const now = new Date().toISOString();
      for (const record of records) appendBackgroundRecord(session, record, now);
      await writeState(state);
      return session;
    });
    saving = write.catch(() => undefined);
    return write;
  };

  const saveSuperseded = (): Promise<HarnessSession | undefined> => {
    if (!superseded.length) return Promise.resolve(undefined);
    return persist(superseded.splice(0)).catch(() => undefined);
  };

  const run = async (turn: VendorBackgroundTurn): Promise<void> => {
    active = turn;
    deps.changed();
    const { observer } = deps;
    const finished: string[] = [];
    observer.startTurn(BACKGROUND_TURN_LABEL);
    // The waiting line is this turn's until another turn starts over it.
    const generation = observer.turnGeneration;
    const owned = (): boolean => observer.turnGeneration === generation && !deps.userTurnRunning();
    const sink: HarnessTurnObserver = {
      onResponseDelta: (text, mode) => observer.response(text, mode ?? 'append'),
      onActivity: (event) => {
        if (event.kind === 'tool-done' || event.kind === 'tool-error') finished.push(`${event.kind === 'tool-error' ? 'failed ' : ''}${event.label}`);
        observer.activityEvent(event);
      },
      onPhase: (phase) => observer.phase(phase),
      onPlan: (entries) => observer.setPlan(entries),
      onApproval: async (title, detail) => (await observer.approval(title, detail)) !== false,
    };
    turn.attach(sink);
    try {
      const outcome = await turn.finished;
      const record = backgroundTurnRecord(outcome, finished);
      if (!owned()) {
        // A user turn superseded this one: it owns the windows' waiting line,
        // and the conversation until it is saved.
        if (record) superseded.push(record);
        return;
      }
      const session = record ? await persist([record]).catch(() => undefined) : undefined;
      // Still this turn's to end: a user turn may have started (and even
      // finished) while that was saved -- and the waiting-stop belongs to
      // whatever turn is showing now, not to this one.
      if (observer.turnGeneration !== generation) return;
      if (session) observer.render(session);
      observer.stopWaiting();
    } finally {
      active = undefined;
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
