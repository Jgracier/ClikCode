/** What the chat shows, derived from bridge events by one pure reducer.
 *
 * Kept in the extension host rather than the webview: a hidden view is
 * rebuilt from this, and the integration test reads it directly.
 *
 * The transcript is the worker's: `messages` always comes from the latest
 * session a snapshot carried, never appended to locally (every transcript
 * display bug ClikCode has had was one row with two sources). The only local
 * copy is the prompt this client just submitted, shown until the worker's
 * own snapshot carries it.
 */
import { chatCostLabel, composerUsageLabel } from '../../../src/tui/render/usage-words';
import { enterAgainSends, STEER_WORDS } from '../../../src/tui/render/steer-rows';
import { asFileDiffs } from '../../../src/agent/line-diff';
import { activityLifecyclePhase, appendThought, childActivity, mergeActivity, orderMarks, resumeTurnClock, sameCall, stoppedCall, turnElapsedMs, withChildTool, type OpenTool, type Thought, type TurnClock } from '../../../src/harness/protocol/activity-view';
import type { FileDiff, HarnessActivityEvent, HarnessQuestionRequest, HarnessSession, IdeAccount, IdeChatSettings, IdeEvent, IdeModelLabel, IdeProvider, WorkerEvent } from './protocol';
import { formatOutput } from './format';
import { modelLabel } from './webview/format';
import { noticeLevel, stripAnsi } from './text';
import type { Remedy } from './compat';
import type { TurnUsage } from '../../../src/harness/protocol/turn-usage';
import { backgroundWorkOf, type BackgroundWork } from '../../../src/harness/protocol/background-agents';
import { readTurnActivities } from '../../../src/turn/turn-activities';
import { endsWithSummary, isApprovalWaitPhase, reasoningHeading, type Decision } from '../../../src/harness/protocol/turn-flow';
import { readTurnMarks } from '../../../src/turn/turn-marks';
import { CHILDREN_SHOWN } from '../../../src/tui/render/child-rows';
import { failureLine } from '../../../src/harness/protocol/stderr-line';
import { pendingPromptText } from '../../../src/tui/render/pending-prompt';

/** One tool call, as the terminal's activity log keeps it: the harness's own
 * event fields (cleaned of escapes), merged frame by frame with the CLI's
 * rules (activity-view.ts). */
export interface Activity extends Pick<HarnessActivityEvent,
  'id' | 'kind' | 'label' | 'category' | 'agent' | 'swarm' | 'output' | 'outputOmitted' | 'outputTail' | 'durationMs' | 'exitCode' | 'childTools' | 'childTokens' | 'outputHead' | 'stopped'> {
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
  /** The turn was stopped: it ends on "Stopped after", not "Worked for". */
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
  steers: Array<{ text: string; offset: number; seq?: number }>;
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
   * terminal's "stopping…". */
  stopping?: boolean;
}

export interface ChatModel {
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
  harness?: string;
  /** The provider id `choose provider` takes: a harness command, `gateway`,
   * or `clikcode-local`. */
  providerId?: string;
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
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  notes: Note[];
  /** `notification`: a finished background task the agent is owed, not
   * something the user typed. */
  queued: Array<{ id: string; text: string; command: boolean; notification?: boolean; held?: boolean }>;
  running: boolean;
  /** This client's submitted prompt, until a snapshot carries it. */
  pendingPrompt?: string;
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

/** What a conversation open in another chat (a tab, or the side bar) asks
 * of the user there: an approval waiting, or a turn that finished while
 * nobody looked. The conversations list marks it, as that tab's title does. */

/** A stamp for `writingAt` / `callAt`: the clock, but strictly after `other`,
 * so two events in one millisecond keep the order they came in (answerWriting
 * compares them). */
function stampAfter(other: number | undefined): number {
  return Math.max(Date.now(), (other ?? Number.NEGATIVE_INFINITY) + 1);
}

/** A turn's durable marks (what a snapshot carries as `live.marks`, a saved
 * answer as `marks`) as the rows this window draws. Anything malformed is
 * skipped (readTurnMarks). */
export interface MarkRows {
  reasoning: ThoughtEntry[];
  plan?: { entries: ChatModel['plan']; at: PlanAt };
  notices: Array<{ id: string; text: string; offset: number; seq: number }>;
  decisions: DecisionEntry[];
}

export function marksToRows(value: unknown): MarkRows {
  const rows: MarkRows = { reasoning: [], notices: [], decisions: [] };
  for (const mark of readTurnMarks(value)) {
    switch (mark.kind) {
      case 'thought':
        rows.reasoning.push({
          text: mark.text ? stripAnsi(mark.text) : '', offset: mark.responseOffset, ms: mark.durationMs, seq: mark.seq,
          ...(mark.heading ? { heading: stripAnsi(mark.heading) } : {}),
        });
        break;
      case 'plan':
        rows.plan = {
          entries: mark.entries.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })),
          at: { offset: mark.responseOffset, seq: mark.seq },
        };
        break;
      case 'notice':
        rows.notices.push({ id: mark.id, text: stripAnsi(mark.message), offset: mark.responseOffset, seq: mark.seq });
        break;
      case 'outcome': {
        const label = stripAnsi(mark.label);
        rows.decisions.push({
          id: mark.id, offset: mark.responseOffset, seq: mark.seq, ...(mark.callId ? { callId: mark.callId } : {}),
          decision: mark.outcome === 'approved' ? { kind: 'approved', label } : mark.outcome === 'answered' ? { kind: 'answered', label } : { kind: 'denied', label },
        });
        break;
      }
    }
  }
  return rows;
}

/** The worker's settled thoughts into the window's own. A row both hold is
 * one (same seq): the worker's duration, heading and place are authoritative,
 * and the window keeps its own text when it is longer (the worker's is
 * capped). Rows only one of them has stay. */
function mergeReasoning(held: ThoughtEntry[], incoming: ThoughtEntry[]): ThoughtEntry[] {
  if (!incoming.length) return held;
  const merged = [...held];
  for (const entry of incoming) {
    const at = merged.findIndex((item) => item.seq === entry.seq);
    if (at < 0) { merged.push(entry); continue; }
    const prior = merged[at]!;
    merged[at] = {
      ...prior, ...entry, text: prior.text.length > entry.text.length ? prior.text : entry.text,
      ...(entry.heading || prior.heading ? { heading: entry.heading ?? prior.heading! } : {}),
    };
  }
  return merged;
}

function mergeDecisions(held: DecisionEntry[] | undefined, incoming: DecisionEntry[]): DecisionEntry[] | undefined {
  if (!incoming.length) return held;
  const merged = [...(held ?? [])];
  for (const entry of incoming) {
    const at = merged.findIndex((item) => item.id === entry.id);
    if (at < 0) merged.push(entry);
    else {
      // The worker's row is authoritative for place; this window's own
      // knowledge of how it was answered (told, always) is not taken back.
      const prior = merged[at]!;
      const keep = prior.decision.kind === 'told' || prior.decision.kind === 'declined'
        || (prior.decision.kind === 'approved' && prior.decision.always && entry.decision.kind === 'approved');
      merged[at] = { ...prior, ...entry, decision: keep ? prior.decision : entry.decision, ...(prior.callId ? { callId: prior.callId } : {}) };
    }
  }
  return merged;
}

/** The thought the worker is having now, as this window continues it. What
 * the window holds wins when it is the same thought or a newer one; a thought
 * the window never saw begin takes the worker's place and start time, and what
 * the window held is settled where it was. A thought already settled (a row
 * of the turn) is never reopened. */
function withWorkerThought(live: LiveTurn, open: { id?: string; text: string; seq: number; responseOffset: number; startedAt: number } | undefined): LiveTurn {
  if (!open || !open.text.trim() || live.reasoning.some((entry) => entry.seq === open.seq)) return live;
  const held = live.thoughtStart;
  if (live.thought && held && held.seq >= open.seq) {
    return held.seq === open.seq && open.text.length > live.thought.text.length
      ? { ...live, thought: { ...live.thought, text: stripAnsi(open.text) } } : live;
  }
  const before = live.thought ? settled(live) : live;
  return {
    ...before, thought: { ...(open.id === undefined ? {} : { id: open.id }), text: stripAnsi(open.text) },
    thoughtStart: { offset: open.responseOffset, at: open.startedAt, seq: open.seq }, seen: Math.max(before.seen, open.seq),
  };
}

/** A row's place in the turn's order (standard 1.2): the worker's `seq` where
 * it sent one, else the next number of this window's own counter. The counter
 * first rises past everything the worker numbered, so a row that has none is
 * never mixed in among the worker's own numbers. */
function takeSeq(live: Pick<LiveTurn, 'seen'>, given?: number): { seq: number; seen: number } {
  if (typeof given === 'number' && Number.isFinite(given)) return { seq: given, seen: Math.max(live.seen, given) };
  return { seq: live.seen + 1, seen: live.seen + 1 };
}

/** A live turn without the phase a report set before the vendor answered. */
function withoutPhase<T extends { phase?: string }>(live: T): T {
  if (live.phase === undefined) return live;
  const { phase: _phase, ...rest } = live;
  return rest as T;
}

export function conversationAttention(id: string, open: ReadonlyArray<{ sessionId?: string; approvals: number; unread: boolean }>): 'waiting' | 'unread' | undefined {
  const showing = open.filter((chat) => chat.sessionId === id);
  if (showing.some((chat) => chat.approvals > 0)) return 'waiting';
  if (showing.some((chat) => chat.unread)) return 'unread';
  return undefined;
}

export function emptyModel(): ChatModel {
  return { connection: 'starting', messages: [], notes: [], queued: [], running: false, plan: [], approvals: [], submissions: [], traces: [] };
}

const MAX_NOTES = 50;
const MAX_ACTIVITIES = 200;
const MAX_TRACES = 100;
/** Characters of a turn's reasoning a trace keeps. */
const MAX_REASONING = 12_000;

/** The provider record, only while it is still the chat's: right after a
 * switch the session has moved and the record not yet been read again. */
export function currentProvider(model: ChatModel): IdeProvider | undefined {
  return model.provider && model.provider.id === model.providerId ? model.provider : undefined;
}

/** The name to show for the chat's provider. */
export function providerDisplayName(model: ChatModel, known?: ReadonlyArray<{ id: string; name: string }>): string | undefined {
  const current = currentProvider(model);
  if (current) return current.name;
  const listed = known?.find((item) => item.id === model.providerId)?.name;
  if (listed) return listed;
  const harness = model.harness;
  return harness ? harness.replace(/(^|[-_ ])(\w)/g, (_match, space: string, letter: string) => `${space ? ' ' : ''}${letter.toUpperCase()}`) : undefined;
}

/** The chat's model as it reads beside its provider (`big-pickle` under
 * OpenCode): the bridge's label while it names this model, else ClikCode's
 * own rule applied here (a model a worker reported since). */
export function chatModelLabel(model: ChatModel, providerName?: string): string | undefined {
  if (!model.model) return undefined;
  if (model.modelLabel?.model === model.model) return model.modelLabel.label;
  return modelLabel(model.model, model.providerId, model.harness, providerName);
}

/** What `choose provider` calls the provider a session runs on. */
export function providerIdOf(session: HarnessSession): string | undefined {
  if (session.route === 'gateway') return 'gateway';
  if (session.route === 'clikcode-local') return 'clikcode-local';
  return session.nativeHarness ?? undefined;
}

function freshFor(model: ChatModel): ChatModel {
  return {
    ...emptyModel(), connection: model.connection,
    ...(model.version ? { version: model.version } : {}), ...(model.revision ? { revision: model.revision } : {}),
  };
}

/** A note goes where it happened: during a turn, after the prompt that
 * started it (the prompt is not in the transcript yet), else at the end. */
export function withNote(model: ChatModel, note: Omit<Note, 'after'>): ChatModel {
  const during = model.running && model.turnUserIndex !== undefined;
  const after = during ? model.turnUserIndex! + 1 : model.messages.length;
  // Mid-turn it is also placed in the turn: at the answer offset where it
  // arrived, in order among the rows, so it neither trails the live turn nor
  // jumps above the answer when the turn ends (standard sections 1, 11).
  const live = during ? model.live : undefined;
  // Where the worker placed it, when it said (WorkerEvent `note`).
  const taken = live ? takeSeq(live, note.seq) : undefined;
  const placed: Note = {
    ...note, after,
    ...(live ? { turn: model.turnUserIndex!, offset: Math.min(note.offset ?? live.text.length, live.text.length), seq: taken!.seq } : {}),
  };
  return {
    ...model, ...(live ? { live: { ...live, seen: taken!.seen } } : {}),
    notes: [...model.notes, placed].slice(-MAX_NOTES),
  };
}

export function applySession(model: ChatModel, session: HarnessSession, account?: string, label?: IdeModelLabel): ChatModel {
  if (model.sessionId && model.sessionId !== session.id) model = freshFor(model);
  // An empty chat that moves to another provider starts clean: what was said about the last one (a
  // cancelled sign-in) is not about this one, and would otherwise keep the welcome off the page.
  else if (model.sessionId === session.id && model.providerId !== undefined && model.providerId !== providerIdOf(session)
    && !model.messages.length && !model.running && !model.pendingPrompt && model.notes.length) model = { ...model, notes: [] };
  const pending = session.pendingTurn;
  return {
    ...model,
    ...(label ? { modelLabel: label } : {}),
    sessionId: session.id,
    title: session.name,
    harness: session.route === 'gateway' ? 'ClikDeploy Gateway' : session.route === 'clikcode-local' ? 'ClikCode Local' : session.nativeHarness,
    providerId: providerIdOf(session),
    // Automatic reads as the Gateway's own `auto`, never as a model it routed to.
    model: session.route === 'gateway' && !session.model && !session.gatewayAgentId ? 'auto' : session.reported?.model ?? session.model ?? undefined,
    account,
    agentId: session.route === 'gateway' ? session.gatewayAgentId : undefined,
    effort: session.route === 'gateway' ? undefined : session.effort || undefined,
    // What an agent may do to this machine applies on every route, the
    // Gateway's included: ClikCode's own agent asks before it edits.
    permissions: session.permissionMode ?? 'ask',
    route: session.route,
    workspace: session.workspace,
    messages: sameMessages(model.messages, session.messages ?? []) ? model.messages : (session.messages ?? []).map(({ role, content }) => ({ role, content })),
    traces: withSavedTraces(model.traces, session.messages ?? []),
    queued: (session.queuedTurns ?? []).map((item) => ({
      id: item.id, text: item.text, command: item.kind === 'command', ...(item.kind === 'notification' ? { notification: true } : {}),
      // The running turn is holding it to send in once no tool call is open
      // (acp-client.ts); queued only in case that moment never comes.
      ...(item.heldForTurn && item.heldForTurn === pending?.startedAt ? { held: true } : {}),
    })),
    // The worker's journal of the running turn has the prompt from here on.
    // A send is drawn before the bridge prepares a worker. A snapshot taken
    // during that preparation has no pendingTurn yet; keep the local prompt
    // until the worker acknowledges it or the send is rejected.
    // The durable copy wins, and the sticky one goes once the transcript
    // holds it (the TUI's pendingPromptText): drawn on top of it, the
    // prompt showed twice.
    pendingPrompt: pendingPromptText({
      ...(pending?.prompt ? { durable: pending.prompt } : {}),
      ...((model.running || model.ownTurn) && model.pendingPrompt ? { sticky: model.pendingPrompt } : {}),
      // Where this turn's prompt lands: the message there, not the last
      // (an answered turn ends on the assistant's reply).
      lastMessage: session.messages?.[model.turnUserIndex ?? model.messages.length],
    }),
  };
}

/** The bridge went away and did not come back: nothing is running on this
 * screen any more, and the prompt this window was showing as pending is not
 * pending (the next snapshot's transcript, or its absence, says what became
 * of it). */
export function connectionLost(model: ChatModel, patch: Partial<ChatModel> = {}): ChatModel {
  return {
    ...model, ...patch, running: false, live: undefined, approvals: [], ownTurn: undefined, pendingPrompt: undefined, turnUserIndex: undefined,
  };
}

/** Show a submitted prompt while the bridge prepares the turn. The worker's
 * turn-start and snapshot replace this temporary copy once they arrive. */
export function submittingPrompt(model: ChatModel, prompt: string): ChatModel {
  // A second send in the window is a message to the turn that is starting
  // (the caller queues it), not a replacement for the first bubble.
  if (preparing(model)) return model;
  return { ...model, ownTurn: true, pendingPrompt: prompt };
}

/** The turn is still on screen but the bridge that feeds it is being
 * restarted (the worker keeps the turn going): nothing animates, and the
 * working line says it is reconnecting (standard section 9). */
export function reconnecting(model: Pick<ChatModel, 'running' | 'connection'>): boolean {
  return model.running && model.connection !== 'ready';
}

/** This client sent a prompt and no turn has started yet (the bridge is
 * preparing a worker): Stop and Esc already apply. */
export function preparing(model: Pick<ChatModel, 'running' | 'ownTurn' | 'pendingPrompt'>): boolean {
  return !model.running && Boolean(model.ownTurn && model.pendingPrompt);
}

/** Preparation can fail before a worker turn exists. Give the composer its
 * text back without leaving a phantom running turn on screen. */
export function rejectedPrompt(model: ChatModel): ChatModel {
  return model.ownTurn && !model.running && model.pendingPrompt
    ? { ...model, ownTurn: undefined, pendingPrompt: undefined }
    : model;
}

/** Every snapshot carries the whole transcript as a new array; the one the
 * page already has is kept when it says the same, so it is not resent. */
function sameMessages(previous: ChatModel['messages'], next: ChatModel['messages']): boolean {
  return previous.length === next.length
    && previous.every((message, index) => message.role === next[index]!.role && message.content === next[index]!.content);
}

/** A finished turn's calls: none is running any more. One still open when
 * the turn was stopped is stopped (stoppedCall, as the terminal and the
 * saved turn have it); one a finished turn never reported finishing settles
 * as done, as the terminal draws it. Kept open, it span and its clock
 * counted on every reopen. */
function settledCalls(activities: Activity[], stopped: boolean): Activity[] {
  const open = (rows: readonly Activity[]): boolean => rows.some((activity) => activity.kind === 'tool-start' || open(activity.children ?? []));
  if (!open(activities)) return activities;
  return activities.map((activity) => {
    const children = activity.children ? { children: settledCalls(activity.children, stopped) } : {};
    if (activity.kind !== 'tool-start') return { ...activity, ...children };
    const { child: _child, ...rest } = activity;
    return { ...(stopped ? stoppedCall(rest) : { ...rest, kind: 'tool-done' as const }), ...children };
  });
}

/** A level of background work as the live turn holds it: every kind, and the
 * agents again as the number older readers take. */
function liveBackground(work: BackgroundWork | undefined): { background?: BackgroundWork; pendingBackground?: number } {
  return work ? { background: work, ...(work.agents ? { pendingBackground: work.agents } : {}) } : {};
}

/** The calls each saved turn kept, as the traces the transcript draws them
 * from. The saved copy wins over this window's own record of the same turn
 * -- its calls and the text they are placed in -- while the reasoning and
 * plan only this window saw stay. Unchanged, the same list comes back, so
 * the page does not redraw the history. */
function withSavedTraces(traces: TurnTrace[], messages: NonNullable<HarnessSession['messages']>): TurnTrace[] {
  const byUser = new Map(traces.map((trace) => [trace.userIndex, trace]));
  let changed = false;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const saved = readTurnActivities(message.activities, message.content.length);
    // The worker's own record of how the turn ended: what the live window
    // said ("Worked for 1m 2s", "Stopped after 3s"), said again on reopen.
    const end = message.turnEnd;
    const work = backgroundWorkOf(end);
    const pendingBackground = work?.agents ?? 0;
    const pendingWorkflows = work?.workflows ?? 0;
    const ended = end ? {
      startedAt: 0, endedAt: Math.max(0, end.ms), ...(end.stopped ? { stopped: true as const } : {}),
      ...(end.usage ? { usage: end.usage } : {}), ...(pendingBackground ? { pendingBackground } : {}),
      ...(pendingWorkflows ? { pendingWorkflows } : {}),
    } : undefined;
    // The worker's durable marks: thoughts, plan, notices, decisions.
    const rows = marksToRows(message.marks);
    const hasMarks = rows.reasoning.length > 0 || Boolean(rows.plan) || rows.notices.length > 0 || rows.decisions.length > 0;
    // A turn with no calls has a trace only to carry its closing line.
    if (!saved.length && !hasMarks && !(ended && (ended.stopped || ended.pendingBackground || ended.pendingWorkflows || endsWithSummary(ended.endedAt, 0)))) return;
    // Folded by the same upsert live frames go through.
    const activities = settledCalls(saved.reduce<LiveTurn>(
      (live, item) => upsertActivity(live, item.event, Math.min(item.responseOffset, message.content.length)), freshLive(''),
    ).activities.map(withoutClock), false);
    const prior = byUser.get(index - 1);
    const stopped = ended?.stopped || activities.some((activity) => activity.stopped);
    // The worker's marks are authoritative for the rows they carry; what only
    // this window recorded (a longer reasoning text) stays.
    const reasoning = rows.reasoning.length ? mergeReasoning(prior?.reasoning ?? [], rows.reasoning) : prior?.reasoning;
    const decisions = mergeDecisions(prior?.decisions, rows.decisions);
    const next: TurnTrace = {
      startedAt: 0, endedAt: 0, ...ended, ...prior, userIndex: index - 1, activities, text: message.content, saved: true, ...(stopped ? { stopped: true } : {}),
      ...(reasoning?.length ? { reasoning } : {}),
      ...(rows.plan ? { plan: rows.plan.entries, planAt: rows.plan.at } : {}),
      ...(rows.notices.length ? { notices: rows.notices } : {}),
      ...(decisions?.length ? { decisions } : {}),
    };
    if (prior && JSON.stringify(prior) === JSON.stringify(next)) return;
    byUser.set(index - 1, next);
    changed = true;
  });
  return changed ? [...byUser.values()].sort((left, right) => left.userIndex - right.userIndex).slice(-MAX_TRACES) : traces;
}

/** A saved turn's row without this window's clock (a saved call is not
 * running: no seconds to count, and nothing that differs between two reads of
 * the same turn). */
function withoutClock(activity: Activity): Activity {
  const { startedAt: _startedAt, ...rest } = activity;
  return activity.children ? { ...rest, children: activity.children.map(withoutClock) } : rest;
}

function cleanEvent(event: HarnessActivityEvent): HarnessActivityEvent {
  const { diff: rawDiff, ...rest } = event;
  const files = asFileDiffs(rawDiff);
  return {
    ...rest,
    label: stripAnsi(event.label).replace(/\s+/g, ' ').trim() || 'tool',
    ...(event.output ? { output: event.output.map(stripAnsi) } : {}),
    ...(files?.length ? { diff: cleanDiff(files) } : {}),
  };
}

function cleanDiff(files: FileDiff[]): FileDiff[] {
  return files.map((file) => ({ ...file, lines: file.lines.map((line) => ({ ...line, text: stripAnsi(line.text) })) }));
}

function asActivity(key: string, event: HarnessActivityEvent, extra: Partial<Activity>): Activity {
  const { parentId: _parent, ...fields } = event;
  return { ...fields, key, ...extra } as Activity;
}

/** Children kept under one sub-agent row. */
const MAX_CHILDREN = 200;

/** A sub-agent's frame into the row of its parent (anywhere in the tree):
 * its words, and -- for a call -- a child row of its own, merged by id like
 * any call, in the order the children began (standard 5). The parent's count
 * is of unique child call ids (withChildTool), never of frames. Returns the
 * rows unchanged when nothing changed, undefined when the parent is not here. */
function placeChild(rows: Activity[], event: HarnessActivityEvent, offset: number): Activity[] | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.key !== event.parentId) {
      const inner = row.children?.length ? placeChild(row.children, event, offset) : undefined;
      if (!inner) continue;
      if (inner === row.children) return rows;
      const next = [...rows];
      next[index] = { ...row, children: inner };
      return next;
    }
    const says = childActivity(row.child, event);
    let parent = withChildTool(row, event);
    let children = row.children;
    if (event.kind !== 'thinking') {
      const held = row.children ?? [];
      const at = held.findIndex((entry) => sameCall(entry, event));
      if (at >= 0) {
        const merged = mergeActivity(held[at]!, event);
        const prior = held[at]!;
        children = [...held];
        children[at] = asActivity(prior.key, merged, {
          ...(prior.startedAt ? { startedAt: prior.startedAt } : {}),
          ...(prior.offset !== undefined ? { offset: prior.offset } : {}),
          ...(prior.seq !== undefined ? { seq: prior.seq } : {}),
          ...(prior.children ? { children: prior.children } : {}),
        });
      } else {
        const key = event.id ?? `${row.key}>#${held.length + 1}`;
        children = [...held, asActivity(key, event, { startedAt: Date.now(), offset, ...(event.seq !== undefined ? { seq: event.seq } : {}) })].slice(-MAX_CHILDREN);
      }
      // Counted from the unique ids it holds while it runs; a finished
      // parent's number is what the harness reported, else what was counted.
      if (row.kind === 'tool-start') parent = { ...parent, childTools: Math.max(parent.childTools ?? 0, children.length) };
    }
    if (says === row.child && parent === row && children === row.children) return rows;
    const next = [...rows];
    next[index] = { ...parent, ...(children ? { children } : {}), ...(says ? { child: says } : { child: undefined }) };
    return next;
  }
  return undefined;
}

/** A running sub-agent's live children for drawing: the last few that are
 * still running, each its own line (one finishing never clears another's).
 * `beside`: it began no later than the parent's row, so it sits directly
 * under it; one that began after more of the answer was written sits at its
 * own place below that text (never above text emitted before it). `newest`
 * carries the parent's count. */
export interface LiveChild { parent: Activity; child: Activity; beside: boolean; newest: boolean }

export function liveChildren(parent: Activity, shown = CHILDREN_SHOWN): LiveChild[] {
  if (parent.kind !== 'tool-start' || !parent.children?.length) return [];
  const running = parent.children.filter((entry) => entry.kind === 'tool-start').slice(-shown);
  return running.map((child, rank) => ({
    parent, child, beside: (child.offset ?? 0) <= (parent.offset ?? 0), newest: rank === running.length - 1,
  }));
}

/** A tool frame into the turn's rows, by the terminal's rules: a later frame
 * of the same call (by id, or the open row with its label) merges into it --
 * never reopening a finished call -- and a sub-agent's frames say what it is
 * doing inside its parent's row rather than adding rows of their own. */
function upsertActivity(live: LiveTurn, raw: HarnessActivityEvent, offset = live.text.length): LiveTurn {
  if (raw.kind === 'thinking' && !raw.parentId) return live;
  const event = cleanEvent(raw);
  if (event.parentId) {
    const placed = placeChild(live.activities, event, offset);
    if (placed === live.activities) return live;
    if (placed) return { ...live, activities: placed };
    // Its parent was never seen (or is gone): its reasoning is nothing to
    // draw, its call is a row of its own rather than lost.
    if (event.kind === 'thinking') return live;
  }
  for (let index = live.activities.length - 1; index >= 0; index -= 1) {
    const prior = live.activities[index]!;
    if (!sameCall(prior, event)) continue;
    const merged = mergeActivity(prior, event);
    const activities = [...live.activities];
    activities[index] = asActivity(prior.key, merged, {
      ...(prior.startedAt ? { startedAt: prior.startedAt } : {}),
      ...(prior.offset !== undefined ? { offset: prior.offset } : {}),
      ...(prior.seq !== undefined ? { seq: prior.seq } : {}),
      ...(prior.children ? { children: prior.children } : {}),
      ...(prior.child && merged.kind === 'tool-start' ? { child: prior.child } : {}),
    });
    return { ...live, activities };
  }
  const { seq, seen } = takeSeq(live, event.seq);
  const row = asActivity(event.id ?? `#${seq}`, event, { startedAt: Date.now(), offset, seq });
  // A call began: answer text after it is a new response (answerWriting).
  const began = event.kind === 'tool-start' ? { callAt: stampAfter(live.writingAt) } : {};
  return { ...live, ...began, seen, activities: [...live.activities, row].slice(-MAX_ACTIVITIES) };
}

/** The terminal's rule: the thought being had accumulates (appendThought);
 * a tool starting, or a new reasoning item, settles it into the turn's
 * reasoning. */
function withThought(live: LiveTurn, event: HarnessActivityEvent): LiveTurn {
  if (event.parentId) return live;
  if (event.kind === 'tool-start') return settled(live);
  if (event.kind !== 'thinking') return live;
  const next = appendThought(live.thought, stripAnsi(event.label), event.id);
  if (!next || next === live.thought) return live;
  const fresh = !live.thought || live.thought.id !== next.id;
  const before = fresh ? settled(live) : live;
  // A thought takes its place in the order when it begins, not when it is
  // settled -- the call it led to is settled after it.
  const taken = takeSeq(before, event.seq);
  return { ...before, thought: next, ...(fresh ? { seen: taken.seen, thoughtStart: { offset: live.text.length, at: Date.now(), seq: taken.seq } } : {}) };
}

/** The thought being had, settled in its place: a tool started, the answer
 * began, or a new reasoning item took over. */
function settled(live: LiveTurn): LiveTurn {
  if (!live.thought) return live;
  const start = live.thoughtStart ?? { offset: live.text.length, at: Date.now(), seq: live.seen };
  return { ...live, thought: undefined, thoughtStart: undefined, reasoning: [...live.reasoning, { text: live.thought.text, offset: start.offset, ms: Date.now() - start.at, seq: start.seq }] };
}

/** The status line follows the work, as in the terminal: the newest open
 * call names the verb, the turn's own phase otherwise. */
function withToolPhase(live: LiveTurn, event: HarnessActivityEvent): LiveTurn {
  if (event.parentId || event.kind === 'thinking') return live;
  const lifecycle = activityLifecyclePhase(new Map(live.openTools), event);
  const closed = live.openTools.length > 0 && !lifecycle.activeTools.size;
  return {
    ...live, openTools: [...lifecycle.activeTools], toolPhase: lifecycle.activeTools.size ? lifecycle.phase : undefined,
    ...(closed ? { thinkingSince: Date.now() } : {}),
  };
}

function applyActivity(live: LiveTurn, event: HarnessActivityEvent, offset?: number): LiveTurn {
  return withToolPhase(withThought(upsertActivity(live, event, offset), event), event);
}

function freshLive(waitingLabel: string, startedAt = Date.now()): LiveTurn {
  return { text: '', waitingLabel, activities: [], reasoning: [], seen: 0, openTools: [], steers: [], startedAt, thinkingSince: Date.now(), activeAt: Date.now() };
}

/** Text replaced wholesale keeps the rows placed in what it kept; one placed
 * past the point where the texts differ moves back to it. */
function rebaseOffsets<T extends { offset?: number }>(items: T[], previous: string, replacement: string): T[] {
  let common = 0;
  while (common < previous.length && common < replacement.length && previous[common] === replacement[common]) common += 1;
  return items.some((item) => (item.offset ?? 0) > common) ? items.map((item) => ((item.offset ?? 0) > common ? { ...item, offset: common } : item)) : items;
}

/** A turn's reasoning for its trace: every thought, the newest kept when
 * there is more than a trace holds. */
function turnReasoning(live: LiveTurn | undefined): ThoughtEntry[] | undefined {
  if (!live) return undefined;
  const all = settled(live).reasoning;
  const kept: ThoughtEntry[] = [];
  let room = MAX_REASONING;
  for (let index = all.length - 1; index >= 0 && room > 0; index -= 1) {
    const entry = all[index]!;
    const text = entry.text.length > room ? `…${entry.text.slice(-room)}` : entry.text;
    kept.unshift({ ...entry, text });
    room -= text.length;
  }
  return kept.length ? kept : undefined;
}

/** The turn's notices the worker kept, added to the window's own as notes at
 * their offsets. One the window already has -- the same mark, the same seq, or
 * the same words at the same place -- is not added again. */
function withNoticeMarks(notes: Note[], turn: number, notices: MarkRows['notices']): Note[] {
  const fresh = notices.filter((notice) => !notes.some((note) => note.turn === turn
    && (note.markId === notice.id || note.seq === notice.seq || (note.text === notice.text && note.offset === notice.offset))));
  if (!fresh.length) return notes;
  return [...notes, ...fresh.map((notice): Note => ({
    kind: 'notice', level: noticeLevel(notice.text), text: notice.text, after: turn + 1, turn, offset: notice.offset, seq: notice.seq, markId: notice.id,
  }))].slice(-MAX_NOTES);
}

export function applyWorkerEvent(model: ChatModel, sessionId: string, event: WorkerEvent): ChatModel {
  if (model.sessionId && sessionId !== model.sessionId) return model;
  switch (event.type) {
    case 'snapshot': {
      const next = applySession(model, event.session, event.account);
      // The worker attaches `live` to every snapshot while a turn runs, so
      // one without it says nothing is running there.
      // `stopped`: another window or the CLI stopped it -- ended as stopped.
      if (!event.live) return model.live ? endTurn({ ...next, pendingPrompt: undefined }, event.stopped === true) : next;
      // The running turn's tool rows and plan come with it (from ClikCode
      // builds that send them), so a panel opened mid-turn shows them too.
      // Joined mid-turn, the clock starts where the turn really did.
      const startedAt = Date.parse(event.session.pendingTurn?.startedAt ?? '') || undefined;
      const base = next.live ?? freshLive('', startedAt);
      // A snapshot adds and updates; it does not erase what only this window
      // held (the thoughts -- never in a snapshot -- and each running call's
      // clock). Calls merge by id, so a finished one is never reopened.
      const replayed = event.live.activities
        ? event.live.activities.reduce<LiveTurn>((live, item) => withToolPhase(upsertActivity(live, item.event, item.responseOffset), item.event), base)
        : base;
      // What the worker holds that a window cannot have seen: its settled
      // thoughts, the plan, the notices and decisions in their own order, and
      // the thought being had. The worker's rows are authoritative for the
      // rows they carry; what only this window held stays.
      const rows = marksToRows(event.live.marks);
      const folded = withWorkerThought({
        ...replayed, reasoning: mergeReasoning(replayed.reasoning, rows.reasoning),
        ...(mergeDecisions(replayed.decisions, rows.decisions) ? { decisions: mergeDecisions(replayed.decisions, rows.decisions)! } : {}),
        ...(rows.plan ? { planAt: rows.plan.at } : {}),
        seen: Math.max(replayed.seen, ...rows.reasoning.map((entry) => entry.seq), ...rows.decisions.map((entry) => entry.seq), rows.plan?.at.seq ?? 0, ...rows.notices.map((entry) => entry.seq)),
      }, event.live.thought);
      // Steers are the turn's own record, so every window shows them.
      // Each takes its place in the order when it was acknowledged: the
      // worker's `seq` where it sends one, else the order this window first
      // saw it in (the earlier window's, kept).
      let seen = folded.seen;
      const held = model.live?.steers ?? [];
      const steers = (event.session.pendingTurn?.steers ?? []).map((steer, index) => {
        const seq = steer.seq ?? held[index]?.seq ?? ++seen;
        seen = Math.max(seen, seq);
        return { text: steer.text, offset: steer.responseOffset ?? event.live!.text.length, seq };
      });
      // The plan the worker says the turn has is placed where this window
      // first saw it (or, joining mid-turn, at the top, as it was drawn
      // before). `planOffset` is where the worker says it really was (absent
      // from an older worker).
      const planAt = folded.planAt ?? (event.live.plan?.length ? { offset: event.live.planOffset ?? 0, seq: ++seen } : undefined);
      // Joined mid-answer: text that came after the turn's last call is
      // being written; the window did not see it arrive, so it says so now.
      const lastCall = folded.activities.reduce((last, item) => Math.max(last, item.offset ?? 0), 0);
      const answering = event.live.text.length > 0 && event.live.text.length > lastCall;
      const grew = event.live.text.length > (model.live?.text.length ?? 0);
      const writing = answering && (folded.writingAt === undefined || grew) ? { writingAt: stampAfter(folded.callAt) } : {};
      // The turn's phase, only while it has not begun to answer, and never the
      // adapters' "waiting for your approval" (stale once it is answered).
      const reported = event.live.phase ? stripAnsi(event.live.phase) : undefined;
      const phase = folded.phase ?? (reported && !event.live.text && !isApprovalWaitPhase(reported) ? reported : undefined);
      const turnIndex = next.turnUserIndex ?? next.messages.length;
      return {
        ...next,
        running: true,
        turnUserIndex: turnIndex,
        notes: withNoticeMarks(next.notes, turnIndex, rows.notices),
        live: {
          ...folded, text: event.live.text, waitingLabel: stripAnsi(event.live.waitingLabel), steers, seen, ...(planAt ? { planAt } : {}), ...writing,
          ...(phase ? { phase } : {}),
          ...liveBackground(backgroundWorkOf(event.live)),
        },
        ...(event.live.usage ? { turnUsage: { ...event.live.usage, ...next.turnUsage } } : {}),
        ...(event.live.plan ? { plan: event.live.plan.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })) }
          : rows.plan && !next.plan.length ? { plan: rows.plan.entries } : {}),
      };
    }
    case 'waiting-start':
      return {
        ...model, running: true, turnUserIndex: model.messages.length,
        live: freshLive(stripAnsi(event.message)), plan: [], submissions: [],
        turnUsage: undefined,
      };
    case 'waiting-stop':
      return { ...endTurn(model, event.stopped === true), pendingPrompt: undefined, approvals: [], submissions: [] };
    case 'delta': {
      const live = model.live ?? freshLive('thinking');
      const text = event.mode === 'replace' ? event.text : live.text + event.text;
      // The thought led to this text; once the answer arrives it is settled.
      // The vendor is answering: a phase reported before it ("switching to …") is over.
      const after = event.text ? withoutPhase(settled(live)) : live;
      const placed = event.mode === 'replace' ? {
        activities: rebaseOffsets(after.activities, live.text, text), steers: rebaseOffsets(after.steers, live.text, text),
        reasoning: rebaseOffsets(after.reasoning, live.text, text),
      } : {};
      const planAt = event.mode === 'replace' && after.planAt ? { planAt: rebaseOffsets([after.planAt], live.text, text)[0]! } : {};
      // The turn's notices are placed in the answer like its rows.
      const notes = event.mode === 'replace' && model.notes.some((note) => note.turn !== undefined && note.turn === model.turnUserIndex)
        ? model.notes.map((note) => (note.turn !== undefined && note.turn === model.turnUserIndex ? rebaseOffsets([note], live.text, text)[0]! : note))
        : model.notes;
      return { ...model, notes, live: { ...after, ...placed, ...planAt, text, activeAt: Date.now(), ...(event.text ? { writingAt: stampAfter(after.callAt) } : {}) } };
    }
    case 'activity': {
      const live = model.live ?? freshLive('thinking');
      return { ...model, live: { ...applyActivity(withoutPhase(live), event.event), activeAt: Date.now() } };
    }
    case 'background': {
      // A level: the vendor's own count of what still runs, by kind.
      const live = model.live ?? freshLive('thinking');
      const { pendingBackground: _held, background: _work, ...rest } = live;
      return { ...model, live: { ...rest, ...liveBackground(backgroundWorkOf({ background: event.work, pendingBackground: event.pending })) } };
    }
    case 'phase':
      // The adapters' own "waiting for your approval" is what the approval
      // card says; kept as the status it would outlast the answer.
      return model.live && !isApprovalWaitPhase(event.message) ? { ...model, live: { ...model.live, phase: stripAnsi(event.message) } } : model;
    case 'plan': {
      const plan = event.entries.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) }));
      // One plan row per turn: placed where it first appeared, updated in place.
      const taken = model.live ? takeSeq(model.live, event.seq) : undefined;
      const live = model.live && !model.live.planAt && plan.length
        ? { ...model.live, seen: taken!.seen, planAt: { offset: Math.min(event.responseOffset ?? model.live.text.length, model.live.text.length), seq: taken!.seq } }
        : model.live;
      return { ...model, plan, ...(live ? { live } : {}) };
    }
    case 'usage': {
      const usage = event.usage;
      const percent = usage.contextPercent ?? (usage.contextUsed && usage.contextWindow ? (usage.contextUsed / usage.contextWindow) * 100 : undefined);
      return {
        ...model, turnUsage: { ...usage },
        ...(percent !== undefined ? { context: { percent: Math.min(100, Math.max(0, percent)), ...(usage.contextUsed ? { used: usage.contextUsed } : {}), ...(usage.contextWindow ? { window: usage.contextWindow } : {}) } } : {}),
      };
    }
    case 'approval-request':
      if (model.approvals.some((item) => item.id === event.id)) return model;
      return {
        ...model,
        // The clock stops while the turn waits on the user, not the agent.
        ...(model.live && model.live.pausedAt === undefined ? { live: { ...model.live, pausedAt: Date.now() } } : {}),
        approvals: [...model.approvals, {
          id: event.id, title: stripAnsi(event.title),
          ...(event.detail ? { detail: stripAnsi(event.detail) } : {}),
          ...(event.rule ? { rule: event.rule } : {}),
          ...askedAt(model, event),
          ...(asFileDiffs(event.preview?.diff)?.length ? { diff: cleanDiff(asFileDiffs(event.preview?.diff)!) } : {}),
        }],
      };
    case 'question-request':
      if (model.approvals.some((item) => item.id === event.id)) return model;
      return {
        ...model,
        ...(model.live && model.live.pausedAt === undefined ? { live: { ...model.live, pausedAt: Date.now() } } : {}),
        approvals: [...model.approvals, { id: event.id, title: stripAnsi(event.request.title), question: event.request, ...askedAt(model, event) }],
      };
    case 'request-closed':
      // Answered in another window, withdrawn by the vendor, or the turn ended.
      // Decided (by any window): the settled row it becomes, once.
      return model.approvals.some((item) => item.id === event.id) || event.outcome
        ? answeredApproval(model, event.id, event.outcome ? { outcome: event.outcome, ...(event.label ? { label: stripAnsi(event.label) } : {}), ...(event.callId ? { callId: event.callId } : {}) } : undefined)
        : model;
    case 'notice':
    case 'note':
      // The terminal colours its notes: yellow for an account switch or a
      // limit, red for a failure. The colour is the level.
      return withNote(model, {
        kind: 'notice', level: noticeLevel(event.message), text: stripAnsi(event.message),
        ...(event.type === 'note' && event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.type === 'note' && event.responseOffset !== undefined ? { offset: event.responseOffset } : {}),
      });
    case 'turn-error': {
      const msg = failureLine(stripAnsi(event.message));
      // Exhaustion is an outcome, not a fault — show it as informational chat
      // text rather than a red error banner so it reads as part of the flow.
      const exhausted = /^(?:All accounts exhausted|Usage Exhausted|Credits Exhausted)\b/i.test(msg.trim());
      return withNote(model, { kind: 'notice', level: exhausted ? 'info' : 'error', text: msg });
    }
    case 'submission':
      return { ...model, submissions: model.submissions.map((item) => (item.id === event.id ? { ...item, disposition: event.disposition, ...(event.unsteered ? { unsteered: true } : {}) } : item)) };
    case 'shutdown':
      // An idle worker retiring (a newer build, an idle timeout) is invisible:
      // the bridge attaches to its replacement. Only a cut-off turn is news.
      if (!model.running) return model;
      return { ...endTurn(withNote(model, { kind: 'notice', level: 'warning', text: `The conversation's worker stopped: ${event.reason}` })), approvals: [] };
    default:
      // suspend/resume, sign-in-request (the bridge handles it), restore-draft
      // (arrives separately) and anything a newer worker says.
      return model;
  }
}

/** The turn is over: its tool rows are kept beside the answer. */
function endTurn(model: ChatModel, stoppedElsewhere = false): ChatModel {
  const asked = Boolean(model.live?.stopping) || stoppedElsewhere;
  const activities = settledCalls(model.live?.activities ?? [], asked);
  const reasoning = turnReasoning(model.live);
  const plan = model.plan.length ? model.plan : undefined;
  const turnNotes = model.notes.some((note) => note.turn !== undefined && note.turn === model.turnUserIndex);
  // The saved turn's calls, when its snapshot came first, win over the ones
  // this window watched (see withSavedTraces).
  const saved = model.traces.find((trace) => trace.userIndex === model.turnUserIndex && trace.saved);
  const decisions = model.live?.decisions?.length ? model.live.decisions : undefined;
  const traces = (activities.length || reasoning || plan || turnNotes || decisions || model.live?.pendingBackground || model.live?.background?.workflows || (asked && model.live?.text)) && model.turnUserIndex !== undefined
    ? [...model.traces.filter((trace) => trace.userIndex !== model.turnUserIndex), {
      userIndex: model.turnUserIndex, activities, ...(reasoning ? { reasoning } : {}), ...(decisions ? { decisions } : {}), ...(plan ? { plan, planAt: model.live?.planAt ?? { offset: 0, seq: 0 } } : {}),
      // Completed steers are materialized as user messages in session.messages.
      // Keeping the live badges in the finished trace displayed each prompt twice.
      ...(model.turnUsage ? { usage: model.turnUsage } : {}),
      ...(model.live?.pendingBackground ? { pendingBackground: model.live.pendingBackground } : {}),
      ...(model.live?.background?.workflows ? { pendingWorkflows: model.live.background.workflows } : {}),
      text: model.live?.text ?? '',
      // Less the time approvals waited, as the terminal's summary counts.
      startedAt: model.live ? Date.now() - liveElapsedMs(model.live, Date.now()) : Date.now(), endedAt: Date.now(),
      ...(saved ? { activities: saved.activities, text: saved.text, saved: true } : {}),
      ...(asked || (saved ?? { activities }).activities.some((activity) => activity.stopped) ? { stopped: true } : {}),
    }].slice(-MAX_TRACES)
    : model.traces;
  // The plan goes with its turn (the trace holds it, at its place): left
  // here an unfinished one drew a second card under the answer.
  return { ...model, running: false, live: undefined, ownTurn: undefined, turnUserIndex: undefined, traces, plan: [] };
}

export function applyEvent(model: ChatModel, event: IdeEvent): ChatModel {
  switch (event.type) {
    case 'ready':
      return {
        ...model, connection: 'ready', version: event.version, connectionError: undefined, remedy: undefined,
        revision: typeof event.revision === 'number' ? event.revision : 1,
      };
    case 'session':
      return applySession(model, event.session, event.account, event.modelLabel);
    case 'worker':
      return applyWorkerEvent(model, event.sessionId, event.event);
    case 'turn-start':
      if (model.sessionId && event.sessionId !== model.sessionId) return model;
      return { ...model, running: true, ownTurn: true, pendingPrompt: event.prompt, queued: model.queued.filter((item) => item.id !== event.queuedTurnId) };
    case 'busy':
      return { ...model, busy: event.label };
    case 'sign-in-link':
      // The turn waits on the user in their browser: its clock stops, as for
      // an approval, and the time is not the turn going quiet.
      if (event.done) {
        if (model.signIn?.id !== event.id) return model;
        const live = model.live && !model.approvals.length ? { ...model.live, activeAt: Date.now(), ...resumed(model.live) } : model.live;
        return { ...model, signIn: undefined, ...(live ? { live } : {}) };
      }
      if (model.live && model.live.pausedAt === undefined) model = { ...model, live: { ...model.live, pausedAt: Date.now() } };
      return { ...model, signIn: { id: event.id, name: event.name, ...(event.url ? { url: event.url } : {}), ...(event.code ? { code: event.code } : {}), ...(event.ask ? { ask: event.ask } : {}) } };
    case 'notice':
      return withNote(model, { kind: 'notice', level: event.level, text: stripAnsi(event.message) });
    case 'panel':
      return withNote(model, { kind: 'panel', title: stripAnsi(event.title), text: stripAnsi(event.body) });
    case 'output': {
      const shown = formatOutput(event.payload);
      if (shown.kind === 'panel') return withNote(model, { kind: 'panel', title: shown.title, text: shown.body });
      if (shown.kind === 'notice') return withNote(model, { kind: 'notice', level: shown.level, text: shown.text });
      return model;
    }
    case 'usage':
      // The terminal's own words: the reset in place of the figure once a
      // window is spent, "Out Of Credits" for a spent balance.
      return {
        ...model, accountUsage: composerUsageLabel(event.label, event.reset), chatCost: chatCostLabel(event.chatCost),
        // Spent, the label already is the reset.
        accountUsageNext: event.reset ? undefined : event.next, accountUsageDetail: event.detail,
      };
    case 'closed':
      return event.sessionId === model.sessionId ? freshFor(model) : model;
    default:
      return model;
  }
}

/** The text of a queued message taken back to edit, once the worker's answer
 * says it left the queue -- and only then: one that was already steered into
 * the turn, or is the turn running now, stays sent, and putting its text in
 * the composer too would send it twice (the terminal's takeBackWaiting does
 * the same). Forgets the request whatever the answer. */
export function takenBackText(takingBack: Map<string, string>, event: Extract<WorkerEvent, { type: 'unqueued' }>): string | undefined {
  const text = takingBack.get(event.id);
  takingBack.delete(event.id);
  return event.outcome === 'removed' ? text : undefined;
}

/** Enter on an empty message box while a turn runs, with a message of the
 * user's already waiting: "enter again" puts it into the chat. The turn
 * keeps running. A background task's notice is not the user's message.
 * Only when it would (enterAgainSends, the terminal's rule too): not a
 * message the turn already holds for its next pause, nor in a turn that
 * could not take one, nor once Stop was asked for. */
export function enterAgainReady(model: Pick<ChatModel, 'queued' | 'running' | 'submissions' | 'live'>): boolean {
  if (!model.running || model.live?.stopping) return false;
  return enterAgainSends(model.queued.filter((item) => !item.notification && !item.command).map((item) => ({
    ...(item.held ? { held: true } : {}),
    ...(model.submissions.some((entry) => entry.id === item.id && entry.unsteered) ? { unsteered: true } : {}),
  })));
}

/** The turn has an answer: assistant text, or a tool row. A thought is not
 *  one. Esc stops a turn that has one, and brings an unanswered prompt back. */
export function turnHasAnswer(model: Pick<ChatModel, 'live'>): boolean {
  const live = model.live;
  if (!live) return false;
  if (live.text.trim()) return true;
  return live.activities.some((item) => item.kind !== 'thinking');
}

/** A queued row's words: where it waits, why when steering was asked for
 * and the turn could not take it, and -- while Enter would do it -- that
 * Enter again puts it into the chat. */
export function queuedRowLabel(model: Pick<ChatModel, 'submissions'>, item: { id: string; held?: boolean }, enterAgain: boolean): string {
  const unsteered = model.submissions.some((entry) => entry.id === item.id && entry.unsteered);
  return [item.held ? STEER_WORDS.held : 'queued', ...(unsteered ? [STEER_WORDS.unsteered] : []), ...(enterAgain ? [STEER_WORDS.sendNow] : [])].join(' · ');
}

/** Stop was asked for: the turn shows it is stopping until it ends. */
export function stoppingTurn(model: ChatModel): ChatModel {
  if (!model.running || model.live?.stopping) return model;
  return { ...model, live: { ...(model.live ?? freshLive('thinking')), stopping: true } };
}

/** Where a request was asked, from what the worker sent with it and the
 * vendor's call it names, if any (an older worker sends neither). */
function askedAt(model: ChatModel, event: { seq?: number; responseOffset?: number; callId?: string }): Partial<Pick<Approval, 'seq' | 'offset' | 'callId'>> {
  return {
    ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
    ...(typeof event.responseOffset === 'number' ? { offset: event.responseOffset } : {}),
    ...(event.callId ? { callId: event.callId } : {}),
  };
}

/** What became of an approval or question: the outcome the worker names or
 * this window's own answer; `always` and `told` are only known to the window
 * that answered. */
export type Decided = { outcome: 'approved' | 'denied' | 'answered' | 'declined'; label?: string; always?: boolean; told?: string; callId?: string };

export function answeredApproval(model: ChatModel, id: string, decided?: Decided): ChatModel {
  const approval = model.approvals.find((item) => item.id === id);
  const approvals = model.approvals.filter((item) => item.id !== id);

  // Time spent on the user's answer is not the turn going quiet, and not
  // the turn's time: the clock runs again once none is waiting.
  const live = model.live && { ...model.live, activeAt: Date.now(), ...(approvals.length || model.signIn ? {} : resumed(model.live)) };
  const settled = live && decided ? withDecision(live, id, approval, decided) : live;
  return { ...model, approvals, ...(settled ? { live: settled } : {}) };
}

/** The decision recorded as a row of the turn, under the id the worker's own
 * `outcome` mark has, so the two are one row. */
function withDecision(live: LiveTurn, id: string, approval: Approval | undefined, decided: Decided): LiveTurn {
  const entryId = `outcome:${id}`;
  const held = live.decisions?.find((entry) => entry.id === entryId);
  const label = decided.label ?? approval?.title ?? (held && 'label' in held.decision ? held.decision.label : undefined) ?? 'request';
  const decision: Decision = decided.told ? { kind: 'told', text: decided.told }
    : decided.outcome === 'approved' ? { kind: 'approved', label, ...(decided.always || (held?.decision.kind === 'approved' && held.decision.always) ? { always: true } : {}) }
      : decided.outcome === 'answered' ? { kind: 'answered', label }
        : decided.outcome === 'declined' ? { kind: 'declined', label } : { kind: 'denied', label };
  if (held) {
    // Told and declined are this window's own knowledge: the worker's plain
    // "denied" does not take them back.
    const keep = held.decision.kind === 'told' || held.decision.kind === 'declined';
    return { ...live, decisions: live.decisions!.map((entry) => (entry.id === entryId ? { ...entry, decision: keep ? entry.decision : decision } : entry)) };
  }
  const taken = takeSeq(live, approval?.seq);
  const entry: DecisionEntry = {
    id: entryId, decision, offset: Math.min(approval?.offset ?? live.text.length, live.text.length), seq: taken.seq,
    ...(approval?.callId || decided.callId ? { callId: (approval?.callId ?? decided.callId)! } : {}),
  };
  return { ...live, seen: taken.seen, decisions: [...(live.decisions ?? []), entry] };
}

/** The clock running again after an approval: the pause added up. */
function resumed(live: LiveTurn): Pick<LiveTurn, 'pausedMs' | 'pausedAt'> {
  if (live.pausedAt === undefined) return {};
  return { pausedMs: resumeTurnClock(liveClock(live), Date.now()).pausedMs, pausedAt: undefined };
}

function liveClock(live: LiveTurn): TurnClock {
  return { startedAt: live.startedAt, pausedMs: live.pausedMs ?? 0, ...(live.pausedAt === undefined ? {} : { pausedAt: live.pausedAt }) };
}

/** How long the running turn has taken, less approvals (turnElapsedMs, the
 * terminal's clock). */
export function liveElapsedMs(live: LiveTurn, now: number): number {
  return turnElapsedMs(liveClock(live), now);
}

export function typedDuringTurn(model: ChatModel, id: string, text: string): ChatModel {
  return { ...model, submissions: [...model.submissions, { id, text }] };
}

export type TurnMark = {
  offset: number; seq: number; activity?: Activity; thought?: ThoughtEntry; steer?: string; steerIndex?: number; plan?: true; note?: Note;
  /** A decision that is a row of its own (not settled on a call's row). */
  decision?: DecisionEntry;
  /** A running sub-agent's live child that sits below text (not beside its
   * parent's row). */
  child?: LiveChild;
};

/** A turn's notices for drawing: the window's own notes of the turn plus the
 * worker's saved ones, a notice both have drawn once (same mark, same seq, or
 * the same words at the same place). */
export function turnNoticeNotes(notes: readonly Note[] | undefined, trace: Pick<TurnTrace, 'notices' | 'userIndex'>): Note[] {
  const held = [...(notes ?? [])];
  for (const notice of trace.notices ?? []) {
    if (held.some((note) => note.markId === notice.id || note.seq === notice.seq || (note.text === notice.text && note.offset === notice.offset))) continue;
    held.push({
      kind: 'notice', level: noticeLevel(notice.text), text: notice.text, after: trace.userIndex + 1, turn: trace.userIndex,
      offset: notice.offset, seq: notice.seq, markId: notice.id,
    });
  }
  return held;
}

/** A turn's calls, thoughts, plan, notices and steered messages in the order
 * they happened (standard section 1): by where in the answer they came, then
 * by `seq` -- the order they began in, a steer's being the moment it was
 * acknowledged. A steer with no seq (a saved turn's) goes after whatever was
 * already at its place. */
export function turnMarks(
  text: string, activities: readonly Activity[], thoughts: readonly ThoughtEntry[], steers: ReadonlyArray<{ text: string; offset: number; seq?: number }>,
  extra: { plan?: PlanAt; notes?: ReadonlyArray<{ offset: number; seq: number; note: Note }>; decisions?: readonly DecisionEntry[] } = {},
): TurnMark[] {
  const at = (offset: number): number => Math.min(offset, text.length);
  // A decision the vendor tied to a call settles that call's row; the others
  // are rows of their own at the place they were asked.
  const onCall = new Map<string, Decision>();
  const alone: DecisionEntry[] = [];
  for (const entry of extra.decisions ?? []) {
    if (entry.callId && activities.some((activity) => activity.key === entry.callId)) onCall.set(entry.callId, entry.decision);
    else alone.push(entry);
  }
  // One comparator for every surface (activity-view.ts orderMarks): the CLI
  // and the extension cannot disagree about where a row sits.
  return orderMarks([
    ...thoughts.map((thought) => ({ offset: at(thought.offset), seq: thought.seq, thought })),
    ...activities.map((activity, index) => ({
      offset: at(activity.offset ?? 0), seq: activity.seq ?? index, activity: onCall.has(activity.key) ? { ...activity, decision: onCall.get(activity.key)! } : activity,
    })),
    ...alone.map((entry) => ({ offset: at(entry.offset), seq: entry.seq, decision: entry })),
    // Live children that began after more answer was written: a row of their
    // own under that text, in the order they began, just after their parent.
    ...activities.flatMap((activity, index) => liveChildren(activity).flatMap((live, rank) => (live.beside ? [] : [{
      offset: at(live.child.offset ?? 0), seq: live.child.seq ?? (activity.seq ?? index) + (rank + 1) / 1000, child: live,
    }]))),
    ...steers.map((steer, steerIndex) => ({ offset: at(steer.offset), seq: steer.seq ?? Number.MAX_SAFE_INTEGER, steer: steer.text, steerIndex })),
    ...(extra.plan ? [{ offset: at(extra.plan.offset), seq: extra.plan.seq, plan: true as const }] : []),
    ...(extra.notes ?? []).map(({ offset, seq, note }) => ({ offset: at(offset), seq, note })),
  ], (mark) => ({ responseOffset: mark.offset, seq: mark.seq }));
}
