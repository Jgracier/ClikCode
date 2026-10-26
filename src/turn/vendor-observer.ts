/** What one vendor turn's transports report, folded into the checkpoint and the
 * screen: the shared observer, usage and pending work. */
import { diagnostic, lifecycle } from '../runtime/lifecycle-log.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessAvailableCommand, HarnessPlanEntry, HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { withWorkspacePaths } from '../harness/protocol/activity-view.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { mergeBackgroundWork, type BackgroundWork, type BackgroundWorkUpdate } from '../harness/protocol/background-agents.js';
import { createPendingWorkTracker } from './pending-work.js';
import { unfinishedUsageRecorder } from './turn-steps.js';
import { turnSink } from './turn-output.js';
import { nativeAvailableCommands } from './vendor-process.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

export type VendorTransport = ReturnType<typeof sessionTurnTransport>;

export function createVendorObserver(ctx: VendorTurnContext) {
  const { session, harness, prompter, checkpoint } = ctx;
  /** Shared by every transport: usage seen on the wire for this attempt.
   * Each report is the attempt's running total, so its fields replace. */
  let turnUsage: TurnUsage | undefined;
  let backgroundNow: BackgroundWork | undefined;
  let activeTransport: VendorTransport | undefined;
  const noteUsage = (usage: TurnUsage): void => {
    turnUsage = { ...turnUsage, ...usage };
    const shown = turnUsage!;
    session.lastUsage = { ...shown, at: new Date().toISOString() };
    prompter?.setTurnUsage(shown);
  };
  /** An attempt that ends without completing -- stopped, failed, or moved to
   * another account -- still spent what it reported, on the account it ran on.
   * Taken once: the attempt's usage is cleared as it is recorded. */
  const recordUnfinishedAttempt = unfinishedUsageRecorder(ctx.state, checkpoint, () => {
    const usage = turnUsage;
    turnUsage = undefined;
    return { sessionId: session.id, accountId: ctx.account.id, provider: harness.provider, model: ctx.model, startedAt: ctx.startedAt, usage };
  });
  const pendingWork = createPendingWorkTracker(harness.command);
  /** The response-delta rule, in one place: to the checkpoint and to the
   * screen alike, so what is shown and what is saved cannot differ. */
  const sink = turnSink(checkpoint, prompter);
  const onActivity = (event: HarnessActivityEvent): void => {
    pendingWork.note(event);
    if (event.kind === 'tool-done' || event.kind === 'tool-error') {
      lifecycle('turn.tool', {
        name: (event.call?.name || event.category || 'tool').slice(0, 80),
        ok: event.kind === 'tool-done',
        ...(event.durationMs !== undefined ? { ms: event.durationMs } : {}),
      });
    }
    sink.activity(withWorkspacePaths(event, session.workspace));
  };
  /** A transport's thought is the whole of it so far: one row per id,
   *  replaced as it grows (activity-events.ts thoughtLabel). */
  const onThought = (thought: string, id?: string): void => {
    const label = thoughtLabel(thought);
    if (label) onActivity({ kind: 'thinking', label, ...(id ? { id } : {}) });
  };
  /** A vendor thread stays on the transport that created it (select.ts),
   * unless ACP and the CLI share its store and it is tied to neither. */
  const keepTransport = (transport: VendorTransport | undefined): void => {
    if (harness.acp?.sharedSessions) return;
    if (transport === 'acp' || transport === 'structured-cli' || transport === 'text-cli') session.nativeTransport ??= transport;
  };
  const onSessionId = async (nativeSessionId: string): Promise<void> => {
    if (session.nativeSessionId === nativeSessionId && !session.nativeSessionPreallocated) return;
    session.nativeSessionId = nativeSessionId;
    session.nativeThreadAccountId = ctx.account.id;
    keepTransport(activeTransport);
    delete session.nativeSessionPreallocated;
    await checkpoint.persistNow();
  };
  /** The observer members every transport implements identically. Each
   * transport spreads this and then overrides only what genuinely differs
   * for it (codex's rate limits and steering, the structured CLI's own idle
   * bookkeeping) -- so a member absent from a transport's literal is a
   * deliberate default, not a forgotten one. */
  const sharedObserver = {
    onActivity, onThought, onUsage: noteUsage,
    onServedModel: (model: string): void => {
      ctx.model = model;
      session.reported = { ...session.reported, at: new Date().toISOString(), model };
      checkpoint.touch();
    },
    // The vendor's own count of what still runs in the background, by kind:
    // agents and workflows are carried to the turn's end line (checkpoint
    // turnEnd), terminals only live; shown to the windows following it.
    onBackgroundWork: (update: BackgroundWorkUpdate): void => {
      backgroundNow = mergeBackgroundWork(backgroundNow, update);
      if (session.pendingTurn) {
        // Terminals stay live-only: a saved turn must not claim one is
        // still running on the next open.
        const { terminals: _live, ...ends } = backgroundNow ?? {};
        const kept = mergeBackgroundWork(undefined, ends);
        if (kept) session.pendingTurn.background = kept; else delete session.pendingTurn.background;
        if (kept?.agents) session.pendingTurn.pendingBackground = kept.agents; else delete session.pendingTurn.pendingBackground;
        checkpoint.touch();
      }
      prompter?.setBackgroundWork?.(backgroundNow);
    },
    onResponseDelta: sink.response,
    onPhase: (phase: string) => prompter?.phase(phase),
    onNotice: (message: string) => {
      diagnostic('vendor.notice', message);
      prompter?.activity(message);
    },
    onPlan: (entries: readonly HarnessPlanEntry[]) => {
      // Kept on the session too: a provider taking the conversation over is
      // told the todos still open (session/canonical.ts).
      session.plan = { entries: entries.map((entry) => ({ ...entry })), at: new Date().toISOString() };
      checkpoint.touch();
      prompter?.setPlan(entries);
    },
    // A native harness runs its OWN tools, so ClikCode has no rule to
    // remember on its behalf -- and with no rule offered the prompter never
    // returns 'always' anyway. Collapsed to a boolean here so that boundary
    // is stated rather than implied.
    onApproval: async (title: string, detail?: string, preview?: ApprovalPreview, signal?: AbortSignal, callId?: string) => (await prompter?.approval(title, detail, preview, undefined, signal, callId)) === true,
    // Only where the screen can ask: a missing member is how a transport
    // learns to cancel the question with a notice instead of hanging on it.
    ...(prompter?.askQuestions ? { onQuestion: (request, signal) => prompter.askQuestions!(request, signal) } : {}),
    onAvailableCommands: (commands: readonly HarnessAvailableCommand[]) => { nativeAvailableCommands.set(session.id, commands); },
  } satisfies HarnessTurnObserver;
  return {
    sharedObserver, onActivity, onSessionId, keepTransport, recordUnfinishedAttempt, pendingWork,
    /** The attempt's usage so far. */
    usage: (): TurnUsage | undefined => turnUsage,
    /** The per-attempt resets, and the transport this attempt runs on. */
    beginAttempt(transport: VendorTransport): void {
      activeTransport = transport;
    },
    resetAttempt(): void {
      turnUsage = undefined;
      pendingWork.reset();
    },
  };
}

export type VendorObserver = ReturnType<typeof createVendorObserver>;
