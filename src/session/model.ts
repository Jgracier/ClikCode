/** What a session and the state file around it are: the conversation, the
 * harness and account it is attached to, and the defaults it inherits. */

import type { AiHarnessAccount, AiHarnessPermissionMode, AiHarnessRoute } from '../harness/definition.js';
import type { ShellNote } from '../commands/ai/shell-run.js';

export interface HarnessSession {
  id: string;
  /** Stable ClikCode conversation root. Native harness sessions are branches
   * beneath this root and are never rewritten into one another. */
  conversationId?: string;
  /** The ClikCode branch this session was created from, when it is a fork or
   * cross-provider handoff. */
  parentSessionId?: string;
  /** The terminal currently driving this conversation. Present only while a
   * process has it open, so a second terminal can tell a live chat from an
   * idle one and never attach to the same conversation twice. */
  claim?: { pid: number; host: string; startedAt: string; heartbeatAt: string };
  /** Describes a portable handoff; the source native session remains intact. */
  handoff?: { fromSessionId: string; fromHarness: string; at: string };
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  effort: string;
  permissionMode?: AiHarnessPermissionMode;
  name?: string;
  /** Who named it. `user` is a /rename and is never overwritten; `provider` is
   * the harness's own title, or one the first turn asked the model for. A name
   * with no source is a legacy one derived from the first message. */
  nameSource?: 'user' | 'provider';
  /** How many turns have carried an embedded title request (see
   * withTitleRequest) while the session stayed unnamed. A model ignoring the
   * request once is not rare enough to give up on permanently, but asking on
   * every future turn forever would eventually annoy one that keeps ignoring
   * it -- capped at TITLE_REQUEST_ATTEMPTS in title.ts. */
  titleAttempts?: number;
  accountFailover: 'never' | 'on-quota-exhausted';
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
  /** `nativeSessionId` was minted by ClikCode (structured-CLI `idKind: 'uuid'`)
   * and the vendor process has not yet confirmed it exists. While set, a retry
   * re-creates with the same id instead of resuming a session that never was. */
  nativeSessionPreallocated?: true;
  nativeStartedAt?: string;
  workspace?: string;
  /** Latest token/context reading reported by the transport for this chat. */
  lastUsage?: { at: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number; costUsd?: number; contextWindow?: number };
  /** What the harness said about itself on its own stream, rather than what it
   * was asked for. `model` is the model it actually ran -- a session set to
   * `automatic`, or one whose vendor silently substituted, showed the request
   * and not the answer. `permissionMode` is the mode it applied. */
  reported?: { at: string; model?: string; permissionMode?: string };
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Crash-safe turn journal. It remains separate until completion so a
   * provider retry cannot accidentally submit the same user prompt twice. */
  pendingTurn?: {
    prompt: string;
    response?: string;
    activities?: string[];
    /** Additional user instructions accepted by a provider's active-turn
     * steering protocol. They are part of this turn, not future prompts. */
    steers?: Array<{ text: string; submittedAt: string; responseOffset?: number; id?: string }>;
    startedAt: string;
    updatedAt: string;
    outputStarted: boolean;
  };
  /** User messages submitted while a provider without active steering was
   * running. Persisted independently so process exit cannot discard them. */
  queuedTurns?: Array<{ id: string; text: string; submittedAt: string; kind?: 'command' }>;
  attachments?: string[];
  /** Output the user's `!<command>` runs produced between turns. Injected into
   * the next turn the way attachments are (see shellContextBlock and
   * drive.ts), then cleared at the same sites as `attachments`. Kept separate
   * from `messages` so a resumed native-harness thread -- which never replays
   * ClikCode's own transcript -- still learns what the shell printed. */
  shellNotes?: ShellNote[];
  /** Provider-native values validated against the selected harness manifest. */
  harnessOptions?: Record<string, unknown>;
}

export interface HarnessDefaultSettings {
  effort: string;
  permissionMode: AiHarnessPermissionMode;
  accountFailover: 'never' | 'on-quota-exhausted';
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
  invocations: Array<{ id: string; accountId: string; provider: string; model?: string; at: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number; costUsd?: number; sessionId?: string; latencyMs: number }>;
  /** Applies to every provider unless a providerSettings entry overrides it. */
  globalSettings: HarnessDefaultSettings;
  /** Keyed by AiLocalHarnessDefinition.provider; only the fields a user has set. */
  providerSettings: Record<string, Partial<HarnessDefaultSettings & { model: string }>>;
}
