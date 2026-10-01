/**
 * What a harness reports while a turn runs, in one place.
 *
 * Every transport used to declare its own turn input with its own callbacks,
 * and they had drifted: codex-app-server carried nine, ACP eight, the gateway
 * two, and the structured CLI adapter none at all -- it reports through
 * harness-event-adapters instead. Four event models for one UI, with nothing
 * saying what a harness owes it. Whether a plan, a thought or a rate limit
 * reached the screen depended on which of two dozen harnesses had been picked,
 * and no test could have caught the gap because there was nothing to compare
 * against.
 *
 * Every member is optional. A transport that cannot report something simply
 * does not call it, which is honest and visible here rather than implied by
 * absence in a private interface. What is NOT optional is the shape: a plan
 * entry means the same thing whichever harness produced it.
 *
 * Transport-specific launch configuration -- binaries, argv, base URLs, config
 * overrides -- is not part of this and stays with each transport, because it
 * genuinely differs.
 */
import type { HarnessActivityEvent } from '../prompter.js';
import type { TurnUsage } from '../protocol/turn-usage.js';
import type { UsageReading } from '../accounts/usage-reading.js';

/** One step of an agent's plan. Codex publishes `{content, status}`, ACP adds
 * a `priority`; the UI reads content and status and ignores the rest. */
export interface HarnessPlanEntry {
  content: string;
  /** Free-form as published. Normalised for display, not for logic. */
  status?: string;
  priority?: string;
}

/** A slash command an agent offers for this session. */
export interface HarnessAvailableCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** The turn's reporting surface. Implemented by the caller, called by the
 * transport. Ordering is the transport's: these are notifications, not a
 * protocol. */
export interface HarnessTurnObserver {
  /** The harness's own id for this conversation, once it is known, so the next
   * turn can resume rather than start again. */
  onSessionId?: (id: string) => void | Promise<void>;
  /** Answer text as it streams. `replace` rewrites what has been shown so far;
   * the default appends. */
  onResponseDelta?: (text: string, mode?: 'append' | 'replace') => void;
  /** Tools starting, finishing and failing, and thinking markers. */
  onActivity?: (event: HarnessActivityEvent) => void;
  /** Reasoning as it streams, where the harness publishes it separately from
   * the answer: the WHOLE thought so far for reasoning item `id`, each call
   * replacing the last one for that id. Without an id, one standalone thought. */
  onThought?: (text: string, id?: string) => void;
  /** Something about the turn the user should be told beside the answer: the
   * vendor substituting another model, compacting the conversation. */
  onNotice?: (message: string) => void;
  /** The agent's plan, republished whole each time it changes. */
  onPlan?: (entries: readonly HarnessPlanEntry[], explanation?: string) => void;
  /** The turn's usage so far. Each transport normalises what its harness
   * publishes before calling this; a later call's fields replace earlier ones
   * (the readings are cumulative within one attempt). */
  onUsage?: (usage: TurnUsage) => void;
  /** The account's plan usage, when the turn itself carries it (Claude
   * Code's rate-limit windows, over its stream or ACP). */
  onQuotaReading?: (reading: UsageReading) => void;
  /** A tool or command needing a yes or no before it runs. */
  onApproval?: (title: string, detail?: string, preview?: import('../../tui/render/approval-block.js').ApprovalPreview) => Promise<boolean>;
  /** Coarse progress ("generating response", "retrying"), for the waiting line. */
  onPhase?: (phase: string) => void;
  /** A model step of a multi-step agent turn is starting: the next response
   * delta begins a new segment of the same reply. */
  onStepStart?: () => void;
  /** Quota and limit numbers the harness volunteers mid-turn. */
  onRateLimits?: (rateLimits: unknown) => void;
  /** Published with a handler while a turn can be steered, and with nothing
   * when it can no longer be. */
  onSteerReady?: (handler?: (text: string) => Promise<void>) => void;
  /** Slash commands the agent offers for this session. */
  onAvailableCommands?: (commands: readonly HarnessAvailableCommand[]) => void;
}
