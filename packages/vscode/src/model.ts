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
import { composerUsageLabel } from '../../../src/tui/render/usage-words';
import { STEER_WORDS } from '../../../src/tui/render/steer-rows';
import { asFileDiffs } from '../../../src/agent/line-diff';
import { activityLifecyclePhase, appendThought, childActivity, mergeActivity, sameCall, withChildTool, type OpenTool, type Thought } from '../../../src/harness/protocol/activity-view';
import type { FileDiff, HarnessActivityEvent, HarnessSession, IdeAccount, IdeChatSettings, IdeEvent, IdeModelLabel, IdeProvider, WorkerEvent } from './protocol';
import { formatOutput } from './format';
import { modelLabel } from './webview/format';
import { noticeLevel, stripAnsi } from './text';
import type { Remedy } from './compat';
import { readTurnActivities } from '../../../src/turn/turn-activities';

/** One tool call, as the terminal's activity log keeps it: the harness's own
 * event fields (cleaned of escapes), merged frame by frame with the CLI's
 * rules (activity-view.ts). */
export interface Activity extends Pick<HarnessActivityEvent,
  'id' | 'kind' | 'label' | 'category' | 'agent' | 'swarm' | 'output' | 'outputOmitted' | 'outputTail' | 'durationMs' | 'exitCode' | 'childTools' | 'childTokens' | 'outputHead'> {
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
}

export interface Note {
  /** Shown after this many transcript messages. */
  after: number;
  kind: 'panel' | 'notice';
  level?: 'info' | 'warning' | 'error';
  title?: string;
  text: string;
}

export interface Approval {
  id: string;
  title: string;
  detail?: string;
  rule?: string;
  /** What the call would change, file by file. */
  diff?: FileDiff[];
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
  /** The plan the turn worked through, as it stood at the end. */
  plan?: ChatModel['plan'];
  startedAt: number;
  endedAt: number;
  /** The calls and text are the saved turn's, not this window's. */
  saved?: boolean;
}

/** One settled thought: what it said, where in the answer it came, and for
 * how long it went on ("Thought for 4s", as Claude Code and Codex say). */
export interface ThoughtEntry { text: string; offset: number; ms: number; seq: number }

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
  /** Messages sent into this turn while it runs, where they landed. */
  steers: Array<{ text: string; offset: number }>;
  startedAt: number;
  /** When the model last went back to thinking -- the turn began, or its
   * last open call closed: how long it has thought, for the status line's
   * words ("still thinking"). Not moved by the answer's deltas, which stay
   * an append and a timestamp on the wire. */
  thinkingSince: number;
  /** When the turn last did anything (a word, a thought, a call) or an
   * approval was answered: quiet past turn-pace's threshold and the working
   * line's spinner turns yellow, as the terminal's does. */
  activeAt: number;
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
  effort?: string;
  permissions?: string;
  route?: string;
  workspace?: string;
  accountUsage?: string;
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
  signIn?: { id: string; name: string; url?: string; code?: string };
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
  const after = model.running && model.turnUserIndex !== undefined ? model.turnUserIndex + 1 : model.messages.length;
  return { ...model, notes: [...model.notes, { ...note, after }].slice(-MAX_NOTES) };
}

export function applySession(model: ChatModel, session: HarnessSession, account?: string, label?: IdeModelLabel): ChatModel {
  if (model.sessionId && model.sessionId !== session.id) model = freshFor(model);
  const pending = session.pendingTurn;
  return {
    ...model,
    ...(label ? { modelLabel: label } : {}),
    sessionId: session.id,
    title: session.name,
    harness: session.route === 'gateway' ? 'ClikDeploy Gateway' : session.route === 'clikcode-local' ? 'ClikCode Local' : session.nativeHarness,
    providerId: providerIdOf(session),
    model: session.reported?.model ?? session.model ?? undefined,
    account,
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
    pendingPrompt: pending?.prompt ?? (model.running ? model.pendingPrompt : undefined),
  };
}

/** Every snapshot carries the whole transcript as a new array; the one the
 * page already has is kept when it says the same, so it is not resent. */
function sameMessages(previous: ChatModel['messages'], next: ChatModel['messages']): boolean {
  return previous.length === next.length
    && previous.every((message, index) => message.role === next[index]!.role && message.content === next[index]!.content);
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
    if (!saved.length) return;
    // Folded by the same upsert live frames go through.
    const activities = saved.reduce<LiveTurn>(
      (live, item) => upsertActivity(live, item.event, Math.min(item.responseOffset, message.content.length)), freshLive(''),
    ).activities.map(({ startedAt: _startedAt, ...activity }) => activity);
    const prior = byUser.get(index - 1);
    const next: TurnTrace = { startedAt: 0, endedAt: 0, ...prior, userIndex: index - 1, activities, text: message.content, saved: true };
    if (prior && JSON.stringify(prior) === JSON.stringify(next)) return;
    byUser.set(index - 1, next);
    changed = true;
  });
  return changed ? [...byUser.values()].sort((left, right) => left.userIndex - right.userIndex).slice(-MAX_TRACES) : traces;
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

/** A tool frame into the turn's rows, by the terminal's rules: a later frame
 * of the same call (by id, or the open row with its label) merges into it --
 * never reopening a finished call -- and a sub-agent's frames say what it is
 * doing inside its parent's row rather than adding rows of their own. */
function upsertActivity(live: LiveTurn, raw: HarnessActivityEvent, offset = live.text.length): LiveTurn {
  if (raw.kind === 'thinking' && !raw.parentId) return live;
  const event = cleanEvent(raw);
  if (event.parentId) {
    const index = live.activities.findIndex((item) => item.key === event.parentId);
    if (index < 0) return live;
    const parent = live.activities[index]!;
    const child = childActivity(parent.child, event);
    const counted = withChildTool(parent, event);
    if (child === parent.child && counted === parent) return live;
    const activities = [...live.activities];
    activities[index] = { ...counted, ...(child ? { child } : { child: undefined }) };
    return { ...live, activities };
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
      ...(prior.child && merged.kind === 'tool-start' ? { child: prior.child } : {}),
    });
    return { ...live, activities };
  }
  const seen = live.seen + 1;
  const row = asActivity(event.id ?? `#${seen}`, event, { startedAt: Date.now(), offset, seq: seen });
  return { ...live, seen, activities: [...live.activities, row].slice(-MAX_ACTIVITIES) };
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
  return { ...before, thought: next, ...(fresh ? { seen: before.seen + 1, thoughtStart: { offset: live.text.length, at: Date.now(), seq: before.seen + 1 } } : {}) };
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

export function applyWorkerEvent(model: ChatModel, sessionId: string, event: WorkerEvent): ChatModel {
  if (model.sessionId && sessionId !== model.sessionId) return model;
  switch (event.type) {
    case 'snapshot': {
      const next = applySession(model, event.session, event.account);
      // The worker attaches `live` to every snapshot while a turn runs, so
      // one without it says nothing is running there.
      if (!event.live) return model.live ? endTurn({ ...next, pendingPrompt: undefined }) : next;
      // The running turn's tool rows and plan come with it (from ClikCode
      // builds that send them), so a panel opened mid-turn shows them too.
      // Joined mid-turn, the clock starts where the turn really did.
      const startedAt = Date.parse(event.session.pendingTurn?.startedAt ?? '') || undefined;
      const base = next.live ?? freshLive('', startedAt);
      const replayed = event.live.activities
        ? event.live.activities.reduce<LiveTurn>((live, item) => applyActivity(live, item.event, item.responseOffset),
          { ...base, activities: [], reasoning: [], thought: undefined, thoughtStart: undefined, seen: 0, openTools: [], toolPhase: undefined })
        : base;
      // Steers are the turn's own record, so every window shows them.
      const steers = (event.session.pendingTurn?.steers ?? []).map((steer) => ({ text: steer.text, offset: steer.responseOffset ?? event.live!.text.length }));
      return {
        ...next,
        running: true,
        turnUserIndex: next.turnUserIndex ?? next.messages.length,
        live: {
          ...replayed, text: event.live.text, waitingLabel: stripAnsi(event.live.waitingLabel), steers,
        },
        ...(event.live.plan ? { plan: event.live.plan.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })) } : {}),
      };
    }
    case 'waiting-start':
      return {
        ...model, running: true, turnUserIndex: model.messages.length,
        live: freshLive(stripAnsi(event.message)), plan: [], submissions: [],
        turnUsage: undefined,
      };
    case 'waiting-stop':
      return { ...endTurn(model), pendingPrompt: undefined, approvals: [], submissions: [] };
    case 'delta': {
      const live = model.live ?? freshLive('thinking');
      const text = event.mode === 'replace' ? event.text : live.text + event.text;
      // The thought led to this text; once the answer arrives it is settled.
      const after = event.text ? settled(live) : live;
      const placed = event.mode === 'replace' ? {
        activities: rebaseOffsets(after.activities, live.text, text), steers: rebaseOffsets(after.steers, live.text, text),
        reasoning: rebaseOffsets(after.reasoning, live.text, text),
      } : {};
      return { ...model, live: { ...after, ...placed, text, activeAt: Date.now() } };
    }
    case 'activity': {
      const live = model.live ?? freshLive('thinking');
      return { ...model, live: { ...applyActivity(live, event.event), activeAt: Date.now() } };
    }
    case 'phase':
      return model.live ? { ...model, live: { ...model.live, phase: stripAnsi(event.message) } } : model;
    case 'plan':
      return { ...model, plan: event.entries.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })) };
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
        approvals: [...model.approvals, {
          id: event.id, title: stripAnsi(event.title),
          ...(event.detail ? { detail: stripAnsi(event.detail) } : {}),
          ...(event.rule ? { rule: event.rule } : {}),
          ...(asFileDiffs(event.preview?.diff)?.length ? { diff: cleanDiff(asFileDiffs(event.preview?.diff)!) } : {}),
        }],
      };
    case 'notice':
    case 'note':
      // The terminal colours its notes: yellow for an account switch or a
      // limit, red for a failure. The colour is the level.
      return withNote(model, { kind: 'notice', level: noticeLevel(event.message), text: stripAnsi(event.message) });
    case 'turn-error':
      return withNote(model, { kind: 'notice', level: 'error', text: stripAnsi(event.message) });
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
function endTurn(model: ChatModel): ChatModel {
  const activities = model.live?.activities ?? [];
  const reasoning = turnReasoning(model.live);
  const plan = model.plan.length ? model.plan : undefined;
  // The saved turn's calls, when its snapshot came first, win over the ones
  // this window watched (see withSavedTraces).
  const saved = model.traces.find((trace) => trace.userIndex === model.turnUserIndex && trace.saved);
  const traces = (activities.length || reasoning || plan) && model.turnUserIndex !== undefined
    ? [...model.traces.filter((trace) => trace.userIndex !== model.turnUserIndex), {
      userIndex: model.turnUserIndex, activities, ...(reasoning ? { reasoning } : {}), ...(plan ? { plan } : {}),
      // Completed steers are materialized as user messages in session.messages.
      // Keeping the live badges in the finished trace displayed each prompt twice.
      text: model.live?.text ?? '',
      startedAt: model.live?.startedAt ?? Date.now(), endedAt: Date.now(),
      ...(saved ? { activities: saved.activities, text: saved.text, saved: true } : {}),
    }].slice(-MAX_TRACES)
    : model.traces;
  return { ...model, running: false, live: undefined, ownTurn: undefined, turnUserIndex: undefined, traces };
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
      if (event.done) return model.signIn?.id === event.id ? { ...model, signIn: undefined } : model;
      return { ...model, signIn: { id: event.id, name: event.name, ...(event.url ? { url: event.url } : {}), ...(event.code ? { code: event.code } : {}) } };
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
      return { ...model, accountUsage: composerUsageLabel(event.label, event.reset) };
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
 * user's already waiting (its row is in the queue): "enter again" -- stop the
 * turn, and what waits goes next, the queue's head first, as the bridge sends
 * it whenever a turn ends. A background task's notice is not the user's
 * message and never makes Enter stop anything. */
export function stopAndSendReady(model: Pick<ChatModel, 'queued' | 'running'>): boolean {
  return model.running && model.queued.some((item) => !item.notification && !item.command);
}

/** A queued row's words: where it waits, why when steering was asked for
 * and the turn could not take it, and -- while Enter would do it -- that
 * Enter again stops the turn and sends it. */
export function queuedRowLabel(model: Pick<ChatModel, 'submissions'>, item: { id: string; held?: boolean }, enterAgain: boolean): string {
  const unsteered = model.submissions.some((entry) => entry.id === item.id && entry.unsteered);
  return [item.held ? STEER_WORDS.held : 'queued', ...(unsteered ? [STEER_WORDS.unsteered] : []), ...(enterAgain ? [STEER_WORDS.stopAndSend] : [])].join(' · ');
}

export function answeredApproval(model: ChatModel, id: string): ChatModel {
  // Time spent on the user's answer is not the turn going quiet.
  return { ...model, approvals: model.approvals.filter((item) => item.id !== id), ...(model.live ? { live: { ...model.live, activeAt: Date.now() } } : {}) };
}

export function typedDuringTurn(model: ChatModel, id: string, text: string): ChatModel {
  return { ...model, submissions: [...model.submissions, { id, text }] };
}

export type TurnMark = { offset: number; seq: number; activity?: Activity; thought?: ThoughtEntry; steer?: string };

/** A turn's calls, thoughts and steered messages in the order they happened:
 * by where in the answer they came, then -- where no text came between
 * them -- by which began first. A message sent into the turn goes after
 * whatever was already at its place. */
export function turnMarks(
  text: string, activities: readonly Activity[], thoughts: readonly ThoughtEntry[], steers: ReadonlyArray<{ text: string; offset: number }>,
): TurnMark[] {
  return [
    ...thoughts.map((thought) => ({ offset: Math.min(thought.offset, text.length), seq: thought.seq, thought })),
    ...activities.map((activity, index) => ({ offset: Math.min(activity.offset ?? 0, text.length), seq: activity.seq ?? index, activity })),
    ...steers.map((steer) => ({ offset: Math.min(steer.offset, text.length), seq: Number.MAX_SAFE_INTEGER, steer: steer.text })),
  ].sort((left, right) => left.offset - right.offset || left.seq - right.seq);
}
