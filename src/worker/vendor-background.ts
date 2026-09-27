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

  const persist = async (record: string): Promise<HarnessSession | undefined> => {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === deps.sessionId);
    if (!session) return undefined;
    appendBackgroundRecord(session, record, new Date().toISOString());
    await writeState(state);
    return session;
  };

  const run = async (turn: VendorBackgroundTurn): Promise<void> => {
    active = turn;
    deps.changed();
    const { observer } = deps;
    const finished: string[] = [];
    observer.startTurn(BACKGROUND_TURN_LABEL);
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
      const session = record ? await persist(record).catch(() => undefined) : undefined;
      // A user turn that superseded this one owns the windows' waiting line.
      if (!deps.userTurnRunning()) {
        if (session) observer.render(session);
        observer.stopWaiting();
      }
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
    userTurnEnded: next,
  };
}
