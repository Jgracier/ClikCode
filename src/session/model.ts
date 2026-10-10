/** What a session and the state file around it are: the conversation, the
 * harness and account it is attached to, and the defaults it inherits. */

import type { AiHarnessAccount, AiHarnessPermissionMode, AiHarnessRoute } from '../harness/definition.js';
import type { ShellNote } from '../commands/ai/shell-run.js';
import type { ConversationSummary, PreviousNativeThread } from './conversation-summary.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';

/** One tool call of a turn: the harness's own event, merged frame by frame
 * into one record per call (activity-view.ts mergeActivity), and how much of
 * the message's text had been written when it began -- where it sits between
 * the paragraphs. The running turn keeps them in `pendingTurn.activities`;
 * the turn's assistant message keeps them once it has ended, so a reopened
 * chat draws every call where it happened. Bounded by size, not by count
 * (turn/turn-activities.ts). */
export type TurnActivity = { event: HarnessActivityEvent; responseOffset: number };

/** A message of the conversation. `activities` only on an assistant message,
 * with `responseOffset` into this message's `content`; absent on anything
 * saved before they were kept (and on turns that called nothing).
 * `attachments` only on a user message: the files sent with it, by path
 * (`content` is only what was typed), so a provider taking the conversation
 * over later still learns what an earlier request was about. */
export type TranscriptMessage = {
  role: 'user' | 'assistant'; content: string; activities?: TurnActivity[]; attachments?: string[];
  /** The steer this user message was, when it was typed into a running turn.
   *  The live copy and this one are the same message, matched by this id. */
  id?: string;
  /** Whose turn a message was: an answer is stamped when its turn is
   * committed (checkpoint.ts sessionTranscriptMessages), every message when
   * the conversation moves to another provider (leaveProvider). The
   * session's own harness says only who answers NEXT; an unstamped message
   * is that harness's. */
  origin?: MessageOrigin;
  /** On the answer a turn ended on: how long the turn took, and whether it
   * was stopped. The turn's closing line ("Worked for 12s", "Stopped after
   * 3s") is drawn from this, so it is there however the conversation is
   * opened again -- not only in the window that watched the turn end. */
  turnEnd?: { ms: number; stopped?: true };
  /** On the answer a turn ended on: the account it moved to on the way,
   * from which, and why ("Switched to work: personal is out of usage"). */
  accountSwitch?: AccountSwitch;
  /** On the answer a turn ended on: the sign-in it needed on the way (a
   * vendor that refused it as signed out), by the name it signed in to. */
  signedInTo?: string;
};

/** A turn moved to another account of the same provider (turn/account-routing.ts). */
export type AccountSwitch = { from: string; to: string; reason: string };

/** The harness (or, for ClikCode's own agent, the route) and model that
 * produced a message. */
export interface MessageOrigin { harness?: string; route: AiHarnessRoute; provider: string | null; model: string | null }

export interface HarnessSession {
  id: string;
  /** Stable ClikCode conversation root, shared by its forks. */
  conversationId?: string;
  /** The session this one was forked from (/fork, /compact), or -- in
   * conversations from before provider switches happened in place -- the
   * branch a switch was made from. */
  parentSessionId?: string;
  /** Made by /fork or /compact: a chat of its own beside the conversation's
   * history, not a piece of it. Set when the fork is made, and on a fork from
   * before the marker existed the first time it is read. */
  fork?: true;
  /** The terminal currently driving this conversation. Present only while a
   * process has it open, so a second terminal can tell a live chat from an
   * idle one and never attach to the same conversation twice. */
  claim?: { pid: number; host: string; startedAt: string; heartbeatAt: string };
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  /** Gateway only: the account-private platform agent chosen in /model.
   * UI state until a separate durable-agent execution path exists. */
  gatewayAgentId?: string;
  /** The private Gateway DM this session uses for the chosen agent. */
  gatewayAgentThreadId?: string;
  /** The chosen agent's display name, for the footer (set when chosen and by each turn). */
  gatewayAgentName?: string;
  effort: string;
  /** `effort` as refused by the vendor for one harness and model
   * (`<harness> <model> <effort>`): turns there run at the vendor's own
   * default until the effort, model or harness changes. */
  effortRefused?: string;
  permissionMode?: AiHarnessPermissionMode;
  /** ClikCode's own agent: whether its shell commands run in the OS sandbox
   * (agent/sandbox.ts, /sandbox). Absent = on (`workspace`); only an explicit
   * `off` turns it off. Read it through sessionSandboxMode. */
  sandbox?: 'off' | 'workspace';
  /** ClikDeploy Gateway only: `fast` asks to be served by the fastest
   * measured provider of the model rather than the cheapest (/fast). */
  speed?: 'fast';
  /** ClikCode's own agent: plan mode -- research only, no edits or commands,
   * until the user approves the plan it proposes (exit_plan_mode), which turns
   * it off. Absent = off. Vendor harnesses keep theirs in harnessOptions. */
  planMode?: boolean;
  name?: string;
  /** Who named it. `user` is a /rename and is never overwritten; `provider` is
   * the harness's own title, or one the first turn asked the model for. A name
   * with no source is a legacy one derived from the first message. */
  nameSource?: 'user' | 'provider';
  /** Whether this conversation has spent its one embedded title request. */
  titleAttempts?: number;
  createdAt: string;
  updatedAt: string;
  /** A closed chat is retained for history but is never reopened implicitly. */
  status: 'active' | 'closed' | 'archived';
  closedAt?: string;
  /** Native agent identity, owned by the selected vendor CLI and never sent to Gateway. */
  nativeHarness?: string;
  /**
   * Set only by an explicit Gateway selection (newGatewayConversation) --
   * never by aiSessionOpenDefault's own default-session-creation path, which
   * silently carries `route`/`provider`/`accountId` forward from whatever
   * session came before even when the user has configured nothing yet.
   * Mirrors nativeHarness's role as an "explicit choice happened" signal for
   * the one route (Gateway) that doesn't otherwise have one.
   */
  gatewayConfirmed?: true;
  nativeSessionId?: string;
  /** The transport that owns nativeSessionId. A thread stays on its transport
   * so an ACP id is never passed to a one-shot CLI, or vice versa. */
  nativeTransport?: 'acp' | 'structured-cli' | 'text-cli';
  /** `nativeSessionId` was minted by ClikCode (structured-CLI `idKind: 'uuid'`)
   * and the vendor process has not yet confirmed it exists. While set, a retry
   * re-creates with the same id instead of resuming a session that never was. */
  nativeSessionPreallocated?: true;
  /** The account whose profile holds `nativeSessionId`'s files. A vendor
   * reads a thread only from the profile it was written in, so this -- not
   * `accountId`, which the user changes at any moment, from any process --
   * says where the thread is and whether it has to move before a turn runs
   * (session/carry.ts reconcileNativeThread). Absent on a conversation from
   * before it was kept; the first turn finds the thread and stamps it. */
  nativeThreadAccountId?: string;
  /** How many of the conversation's turns ClikCode's own agent has in its
   * memory (`sessions/<id>/harness.jsonl`). The agent only remembers what
   * it ran itself, so turns that ran elsewhere -- before the conversation
   * moved onto the Gateway or ClikCode Local, or while it was on another
   * provider -- are written into that memory before its next model call
   * (turn/agent-history.ts). */
  agentThreadTurns?: number;
  /** The conversation's summary, from whichever harness compacted it: the
   * next provider gets it in place of the turns it covers
   * (session/conversation-summary.ts). */
  summary?: ConversationSummary;
  /** The vendor thread the conversation had before it moved to another
   * provider: a summary that vendor wrote is read from it. */
  previousNativeThread?: PreviousNativeThread;
  nativeStartedAt?: string;
  /** Every vendor thread this conversation has used and let go of (a
   * switch, a new account, a thread the vendor lost), as `<harness>:<id>`.
   * They are ClikCode's own, so another CLI's history never lists them as
   * chats to adopt (session/discovery/owned.ts). */
  ownedThreads?: string[];
  workspace?: string;
  /** Latest token/context reading reported by the transport for this chat. */
  lastUsage?: TurnUsage & { at: string };
  /** What the harness said about itself on its own stream, rather than what it
   * was asked for. `model` is the model it actually ran -- a session set to
   * `automatic`, or one whose vendor silently substituted, showed the request
   * and not the answer. `permissionMode` is the mode it applied. */
  reported?: { at: string; model?: string; permissionMode?: string };
  messages?: TranscriptMessage[];
  /** Last thing asked, for the conversation list. Written when the transcript
   * changes, so the list does not open the transcript. */
  listPreview?: string;
  /** How many messages the transcript holds. Same purpose as `listPreview`. */
  listMessageCount?: number;
  /** Set once the transcript has been summarized onto this row. Distinguishes
   * "not looked at yet" from "looked at, and it was empty". */
  listChecked?: boolean;
  /** Crash-safe turn journal. It remains separate until completion so a
   * provider retry cannot accidentally submit the same user prompt twice. */
  pendingTurn?: {
    prompt: string;
    /** The files attached to this request (`attachments` when it began). */
    attachments?: string[];
    response?: string;
    /** The turn's tool calls so far, offsets into `response`. Journals
     * written before this held one-line strings ("completed Bash"); read
     * them through readTurnActivities, never directly. */
    activities?: TurnActivity[];
    /** Additional user instructions accepted by a provider's active-turn
     * steering protocol. They are part of this turn, not future prompts. */
    steers?: Array<{ text: string; submittedAt: string; responseOffset?: number; id?: string }>;
    startedAt: string;
    updatedAt: string;
    outputStarted: boolean;
    /** The worker ended this attempt with an error. Keep its partial work
     * for a later continuation, but do not show it as a live turn. */
    failedAt?: string;
    /** Sub-agents this turn has running, so another terminal's conversation
     * list can show them. Part of the journal, so it ends with the turn. */
    subagents?: Array<{ id: string; label: string; startedAt: string; step?: string; stepAt?: string; provider?: string }>;
    /** The account this turn moved to, carried onto its answer at the end. */
    accountSwitch?: AccountSwitch;
    /** A sign-in this turn needed and got, carried onto its answer too. */
    signedInTo?: string;
  };
  /** User messages submitted while a provider without active steering was
   * running. Persisted independently so process exit cannot discard them. */
  queuedTurns?: Array<{
    id: string; text: string; submittedAt: string; kind?: 'command' | 'notification';
    /** The running turn (its pendingTurn.startedAt) is holding this message
     * to steer in at its next safe moment -- no tool call open, so nothing
     * running is interrupted. Queued only as the fallback: it runs as the next
     * turn if that turn ends first. Meaningless once that turn is over. */
    heldForTurn?: string;
  }>;
  /** A turn that ran out of usage everywhere, parked until the provider's
   * quota resets ("Wait for reset"); the worker sends it then. */
  resumeAt?: import('../turn/usage-exhausted.js').ResumeAt;
  attachments?: string[];
  /** Output the user's `!<command>` runs produced between turns. Injected into
   * the next turn the way attachments are (see shellContextBlock and
   * turn/session-turn.ts), then cleared at the same sites as `attachments`. Kept separate
   * from `messages` so a resumed native-harness thread -- which never replays
   * ClikCode's own transcript -- still learns what the shell printed. */
  shellNotes?: ShellNote[];
  /** Provider-native values validated against the selected harness manifest. */
  harnessOptions?: Record<string, unknown>;
  /** Swarm is off until this conversation turns it on. A saved preset list
   * from before the single switch still means on. */
  swarm?: boolean | string[];
  /** The plan (todo list) the provider last published, and when. Kept so a
   * provider taking the conversation over learns what was still open. */
  plan?: { entries: Array<{ content: string; status?: string; priority?: string }>; at: string };
  /** Set on a clerk run that was stored by mistake. Those rows are not chats. */
  clerkOf?: string;
  /** A branch from before provider switches happened in place, whose whole
   * history the named session carries on (its turns
   * the other lacked were merged into it first). Kept, never listed. */
  foldedInto?: string;
}

export interface HarnessDefaultSettings {
  effort: string;
  permissionMode: AiHarnessPermissionMode;
  /** Global only: what a message typed mid-turn does (`/send`,
   *  turn/send-mode.ts). Absent means steer. */
  sendMode?: 'steer' | 'queue';
}

export interface HarnessState {
  version: number;
  installationId: string;
  /** Bearer secret for the loopback protocol; never rendered by CLI commands or HTTP responses. */
  localApiToken: string;
  /** Device-authentication keypair, never a provider credential. Private half stays local. */
  devicePrivateKeyPem: string;
  devicePublicKey: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: HarnessSession[];
  /** `model` is OPTIONAL on purpose. It used to be required, which forced
   *  every writer to invent a value when it did not know one --
   *  'provider-default', 'platform' -- and those fake ids then flowed into
   *  usage rollups as if a model by that name had served the request. An
   *  absent model is a fact; a fabricated one corrupts the accounting. */
  invocations: Array<{ id: string; accountId: string; provider: string; model?: string; at: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number; costUsd?: number; credits?: number; sessionId?: string; latencyMs: number; contextProfile?: string; stopReason?: 'stopped' | 'error' }>;
  /** Applies to every provider unless a providerSettings entry overrides it. */
  globalSettings: HarnessDefaultSettings;
  /** Keyed by AiLocalHarnessDefinition.provider; only the fields a user has set. */
  providerSettings: Record<string, Partial<HarnessDefaultSettings & { model: string }>>;
}
