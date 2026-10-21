/** The shapes the chat model is made of. */
import type { OpenTool, Thought } from '../../../../src/harness/protocol/activity-view';
import type { FileDiff, HarnessActivityEvent, HarnessQuestionRequest, IdeAccount, IdeChatSettings, IdeModelLabel, IdeProvider, WorkerEvent } from '../protocol';
import type { Remedy } from '../compat';
import type { TurnUsage } from '../../../../src/harness/protocol/turn-usage';
import type { BackgroundWork } from '../../../../src/harness/protocol/background-agents';
import type { Decision } from '../../../../src/harness/protocol/turn-flow';

/** One tool call, as the terminal's activity log keeps it: the harness's own
 * event fields (cleaned of escapes), merged frame by frame with the CLI's
 * rules (activity-view.ts). */
export interface Activity extends Pick<HarnessActivityEvent,
  'id' | 'kind' | 'label' | 'category' | 'agent' | 'output' | 'outputOmitted' | 'outputTail' | 'durationMs' | 'exitCode' | 'childTools' | 'childTokens' | 'outputHead' | 'stopped' | 'call'> {
  /** The call's id, or its position for a harness that sends none. */
  key: string;
  /** Each file the call changed, as hunks (see src/agent/line-diff.ts). */
  diff?: FileDiff[];
  /** When this window first saw the call: a running call's clock. */
  startedAt?: number;
  /** What a sub-agent this call started is doing now. */
  child?: string;
  /** How much of the answer had streamed when the call began: where it sits
   * between the answer's paragraphs while the turn runs. */
  offset?: number;
  /** When it came among the turn's calls and thoughts: their order where no
   * text came between them. */
  seq?: number;
  /** What the user decided at this call's approval, when the vendor named the
   * call: the row says `✓ approved` instead of a second row (standard 8). */
  decision?: Decision;
  /** A sub-agent's own calls, in the order they began (standard 5). */
  children?: Activity[];
}

export interface Note {
  /** Shown after this many transcript messages. */
  after: number;
  kind: 'panel' | 'notice';
  level?: 'info' | 'warning' | 'error';
  title?: string;
  text: string;
  /** The running turn's prompt index, and where in its answer (and in what
   * order among its rows) the note arrived: it stays there when the turn
   * ends. Absent for a note outside a turn. */
  turn?: number;
  offset?: number;
  seq?: number;
  /** The worker's mark id, so a notice that came as an event and again in a
   * snapshot is one row. */
  markId?: string;
}

export interface Approval {
  id: string;
  title: string;
  detail?: string;
  rule?: string;
  /** What the call would change, file by file. */
  diff?: FileDiff[];
  /** Where the request was asked (the worker's order and place), and the call
   * it is about when the vendor named one: the decision settles that row. */
  seq?: number;
  offset?: number;
  callId?: string;
  /** Set when a harness asks a question rather than a yes or no: it queues
   * with the approvals (one at a time, the turn's clock stopped, the chat
   * marked waiting) and is drawn as a QuestionCard. */
  question?: HarnessQuestionRequest;
}

/** A finished turn's tool activity, kept beside the answer it produced. Its
 * calls are the saved turn's own (`activities` on the assistant message, the
 * same record the terminal draws a reopened turn from), so a panel opened
 * after the turn shows them too; its reasoning and plan are this window's
 * own record of the turn, and go with the window. */
export interface TurnTrace {
  /** Index in `messages` of the prompt the turn answered. */
  userIndex: number;
  activities: Activity[];
  /** The turn's reasoning, one entry per thought, where it happened. */
  reasoning?: ThoughtEntry[];
  /** Messages sent into the turn while it ran, where they landed. */
  steers?: LiveTurn['steers'];
  /** The answer as it streamed: rows and thoughts are placed in the saved
   * answer only where it still reads the same up to their place. */
  text: string;
  /** The plan the turn worked through, as it stood at the end, and where in
   * the turn it first appeared (one plan row per turn). */
  plan?: ChatModel['plan'];
  planAt?: PlanAt;
  startedAt: number;
  endedAt: number;
  /** Notices and the user's decisions at the turn's approvals, where they
   * were, from the worker's marks (this window's own notes are in `notes`). */
  notices?: Array<{ id: string; text: string; offset: number; seq: number }>;
  decisions?: DecisionEntry[];
  /** What the turn reported it spent, and the background agents it left
   * running: the closing line says them. */
  usage?: TurnUsage;
  pendingBackground?: number;
  /** Dynamic workflows it left running: the closing line says them too. */
  pendingWorkflows?: number;
  /** The calls and text are the saved turn's, not this window's. */
  saved?: boolean;
  /** The turn was stopped: it ends on "Stopped", not "Worked for". */
  stopped?: boolean;
}

/** One settled thought: what it said, where in the answer it came, and for
 * how long it went on ("Thought for 4s", as Claude Code and Codex say). */
/** Where a turn's one plan row sits: the answer offset it first appeared at,
 * and its place in the order of the turn's rows. */
export interface PlanAt { offset: number; seq: number }

export interface ThoughtEntry {
  text: string; offset: number; ms: number; seq: number;
  /** The model's own `**heading**`, when the worker's mark carried one (the
   * text may be capped or absent; the heading and the duration are not). */
  heading?: string;
}

/** What the user decided at an approval or question, where it was asked
 * (standard 8): drawn as a settled row, or on the call's own row when the
 * vendor named the call (`callId`). */
export interface DecisionEntry { id: string; decision: Decision; offset: number; seq: number; callId?: string }

export interface LiveTurn {
  text: string;
  waitingLabel: string;
  phase?: string;
  /** The thought being had now, accumulated as the terminal does, and where
   * and when it began. */
  thought?: Thought;
  thoughtStart?: { offset: number; at: number; seq: number };
  /** Earlier thoughts of this turn, each where it happened. */
  reasoning: ThoughtEntry[];
  activities: Activity[];
  /** Calls and thoughts begun so far: each one's place in their order, and
   * the key of a call that came without an id. */
  seen: number;
  /** The calls still open, and what the newest is doing ("running tests",
   * "editing app.ts") -- the terminal's own status rule. */
  openTools: Array<[string, OpenTool]>;
  toolPhase?: string;
  /** Messages sent into this turn while it runs, where they landed, and
   * the order they were acknowledged in (`seq`, as every row has). */
  steers: Array<{ id?: string; text: string; offset: number; seq?: number }>;
  /** Where the turn's plan first appeared. */
  planAt?: PlanAt;
  /** The approvals and questions of this turn the user has settled. */
  decisions?: DecisionEntry[];
  /** Background agents the vendor says are still running (a level). */
  pendingBackground?: number;
  /** Every kind the vendor says runs in the background (a level): agents and
   * workflows for the closing line, terminals for the working line. */
  background?: BackgroundWork;
  startedAt: number;
  /** When the model last went back to thinking -- the turn began, or its
   * last open call closed. Not moved by the answer's deltas. */
  thinkingSince: number;
  /** When answer text last arrived, and when the turn's last call began: the
   * working line says "writing" while text is the later of the two
   * (answerWriting), however long the pause. Ordered stamps, not wall time:
   * see `stampAfter`. */
  writingAt?: number;
  callAt?: number;
  /** When the turn last did anything (a word, a thought, a call) or an
   * approval was answered: quiet past turn-pace's threshold and the working
   * line's spinner turns yellow, as the terminal's does. */
  activeAt: number;
  /** Time spent waiting on an approval, which the clock leaves out as the
   * terminal's does, and since when one is up (the clock stops). */
  pausedMs?: number;
  pausedAt?: number;
  /** Stop was asked for (the button, Esc, the command): the working line
   * says so and Stop cannot be asked again, until the turn ends -- the
   * terminal's "stopping…". Set only by the worker's `stopping` event. */
  stopping?: boolean;
}

export interface ChatModel {
  /** The worker accepted a Stop before the turn it is for has started; carried
   * onto the turn when it starts, cleared by its end or `stop-done`. */
  stopPending?: boolean;
  connection: 'starting' | 'ready' | 'stopped' | 'error';
  /** IDE protocol revision the bridge speaks (compat.ts refuses one older
   * than the structured queries the panel's menus are built on). */
  revision?: number;
  connectionError?: string;
  /** What the banner offers besides Retry: install ClikCode, update it (too
   * old for this extension), or update the extension (ClikCode is newer). */
  remedy?: Remedy;
  version?: string;
  sessionId?: string;
  title?: string;
  /** Name of the SSH machine that owns this chat; absent for this machine. */
  machine?: string;
  machineId?: string;
  harness?: string;
  /** The provider id `choose provider` takes: a harness command, `gateway`,
   * or `clikcode-local`. */
  providerId?: string;
  /** The provider's name as the bridge says it (absent from an older bridge). */
  providerName?: string;
  /** The model id, as the session has it (sent back unchanged). */
  model?: string;
  /** The bridge's label for a model, from the last `session` event. */
  modelLabel?: IdeModelLabel;
  account?: string;
  /** The Gateway agent this chat runs as (its id; the model menu has its name). */
  agentId?: string;
  effort?: string;
  permissions?: string;
  route?: string;
  workspace?: string;
  accountUsage?: string;
  /** When the window closest to running out resets, while it has not: "5h
   * resets 5:34PM" (with the date when not today). */
  accountUsageNext?: string;
  /** Every window, its share left and its reset, one per line. */
  accountUsageDetail?: string;
  /** "$1.23 this chat", from the bridge's `usage`; absent while no turn
   * reported a cost. */
  chatCost?: string;
  /** `automatic`: a prompt ClikCode sent itself, drawn as this notice (TranscriptMessage.automatic). */
  messages: Array<{ role: 'user' | 'assistant'; content: string; automatic?: string }>;
  notes: Note[];
  queued: Array<{ id: string; text: string; command: boolean; held?: boolean }>;
  running: boolean;
  /** This client's submitted prompt, until a snapshot carries it. */
  pendingPrompt?: string;
  /** The running turn's prompt is ClikCode's own: this notice is drawn in its place. */
  pendingNotice?: string;
  live?: LiveTurn;
  /** This client started the running turn (else it follows another's). */
  ownTurn?: boolean;
  /** Where the running turn's prompt lands in `messages`. */
  turnUserIndex?: number;
  traces: TurnTrace[];
  plan: Array<{ content: string; status?: string }>;
  turnUsage?: Extract<WorkerEvent, { type: 'usage' }>['usage'];
  /** The conversation's context window as last reported: kept between turns
   * (a turn's usage starts empty) and dropped with the conversation. */
  context?: { used?: number; window?: number; percent: number };
  approvals: Approval[];
  busy?: string;
  /** A sign-in the bridge is running: its card shows the link and code. */
  signIn?: { id: string; name: string; url?: string; code?: string; ask?: { prompt: string; secret?: boolean } };
  /** A message typed during the turn and what became of it. */
  submissions: Array<{ id: string; text: string; disposition?: string; unsteered?: boolean }>;
  /** Read by the extension after each change of conversation. */
  chatSettings?: IdeChatSettings;
  provider?: IdeProvider;
  currentAccount?: IdeAccount;
}

/** A running sub-agent's live children for drawing: the last few that are
 * still running, each its own line (one finishing never clears another's).
 * `beside`: it began no later than the parent's row, so it sits directly
 * under it; one that began after more of the answer was written sits at its
 * own place below that text (never above text emitted before it). `newest`
 * carries the parent's count. */
export interface LiveChild { parent: Activity; child: Activity; beside: boolean; newest: boolean }

/** What became of an approval or question: the outcome the worker names or
 * this window's own answer; `always` and `told` are only known to the window
 * that answered. */
export type Decided = { outcome: 'approved' | 'denied' | 'answered' | 'declined'; label?: string; always?: boolean; told?: string; callId?: string };

export type TurnMark = {
  offset: number; seq: number; activity?: Activity; thought?: ThoughtEntry; steer?: string; steerIndex?: number; steerId?: string; plan?: true; note?: Note;
  /** A decision that is a row of its own (not settled on a call's row). */
  decision?: DecisionEntry;
  /** A running sub-agent's live child that sits below text (not beside its
   * parent's row). */
  child?: LiveChild;
};
