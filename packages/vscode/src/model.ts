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
import type { HarnessActivityEvent, HarnessSession, IdeAccount, IdeChatSettings, IdeEvent, IdeModelLabel, IdeProvider, WorkerEvent } from './protocol';
import { formatOutput } from './format';
import { modelLabel } from './webview/format';
import { diffInDetail, stripAnsi } from './text';
import type { Remedy } from './compat';

export interface Activity {
  key: string;
  kind: HarnessActivityEvent['kind'];
  label: string;
  category?: string;
  output?: string[];
  diff?: { removed: string[]; added: string[] };
  /** When this window first saw the call: a running call's clock. */
  startedAt?: number;
  /** How long it ran, and a command's exit code, where the harness reports them. */
  durationMs?: number;
  exitCode?: number;
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
  hasDiff: boolean;
}

/** A finished turn's tool activity, kept beside the answer it produced. The
 * worker's transcript holds only the messages; this is the editor's own
 * record of how the answer was reached, and goes with the window. */
export interface TurnTrace {
  /** Index in `messages` of the prompt the turn answered. */
  userIndex: number;
  activities: Activity[];
  startedAt: number;
  endedAt: number;
}

export interface LiveTurn {
  text: string;
  waitingLabel: string;
  phase?: string;
  /** The most recent thought, on one line, as the terminal shows it. */
  thought?: string;
  activities: Activity[];
  startedAt: number;
  /** When the turn last said anything: text, a tool, a thought, a phase. */
  lastEventAt: number;
}

export interface ChatModel {
  connection: 'starting' | 'ready' | 'stopped' | 'error';
  /** IDE protocol revision the bridge speaks: 2 and up has the structured
   * queries the provider menu, history and accounts screens are built on. */
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
  queued: Array<{ id: string; text: string; command: boolean }>;
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
  approvals: Approval[];
  busy?: string;
  /** A message typed during the turn and what became of it. */
  submissions: Array<{ id: string; text: string; disposition?: string }>;
  /** Read by the extension after each change of conversation (revision 2). */
  chatSettings?: IdeChatSettings;
  provider?: IdeProvider;
  currentAccount?: IdeAccount;
}

export function emptyModel(): ChatModel {
  return { connection: 'starting', messages: [], notes: [], queued: [], running: false, plan: [], approvals: [], submissions: [], traces: [] };
}

const MAX_NOTES = 50;
const MAX_ACTIVITIES = 200;
const MAX_TRACES = 100;

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

function withNote(model: ChatModel, note: Omit<Note, 'after'>): ChatModel {
  return { ...model, notes: [...model.notes, { ...note, after: model.messages.length }].slice(-MAX_NOTES) };
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
    messages: sameMessages(model.messages, session.messages ?? []) ? model.messages : session.messages ?? [],
    queued: (session.queuedTurns ?? []).map((item) => ({ id: item.id, text: item.text, command: item.kind === 'command' })),
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

function upsertActivity(activities: Activity[], event: HarnessActivityEvent): Activity[] {
  const activity: Activity = {
    key: event.id ?? `${activities.length}`,
    kind: event.kind,
    label: stripAnsi(event.label),
    ...(event.category ? { category: event.category } : {}),
    ...(event.output?.length ? { output: event.output.map(stripAnsi) } : {}),
    ...(event.diff ? { diff: { removed: [...event.diff.removed], added: [...event.diff.added] } } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };
  if (event.parentId) return activities;
  if (event.id) {
    const index = activities.findIndex((item) => item.key === event.id);
    if (index >= 0) return activities.map((item, position) => (position === index ? { ...item, ...activity, label: activity.label || item.label } : item));
  }
  return [...activities, { ...activity, startedAt: Date.now() }].slice(-MAX_ACTIVITIES);
}

function freshLive(waitingLabel: string): LiveTurn {
  const now = Date.now();
  return { text: '', waitingLabel, activities: [], startedAt: now, lastEventAt: now };
}

/** The terminal's rule: the latest thought stays until a tool starts, and a
 * bare "thinking" says nothing the spinner does not. */
function latestThought(current: string | undefined, event: HarnessActivityEvent): string | undefined {
  if (event.parentId) return current;
  if (event.kind === 'tool-start') return undefined;
  if (event.kind !== 'thinking') return current;
  const thought = stripAnsi(event.label).replace(/\s+/g, ' ').trim();
  return thought && thought.toLowerCase() !== 'thinking' ? thought : current;
}

export function applyWorkerEvent(model: ChatModel, sessionId: string, event: WorkerEvent): ChatModel {
  if (model.sessionId && sessionId !== model.sessionId) return model;
  switch (event.type) {
    case 'snapshot': {
      const next = applySession(model, event.session, event.account);
      // The worker attaches `live` to every snapshot while a turn runs, so
      // one without it says nothing is running there.
      if (!event.live) return model.live ? endTurn({ ...next, pendingPrompt: undefined }) : next;
      return {
        ...next,
        running: true,
        turnUserIndex: next.turnUserIndex ?? next.messages.length,
        live: {
          ...(next.live ?? freshLive('')), text: event.live.text, waitingLabel: stripAnsi(event.live.waitingLabel),
          ...(next.live?.text === event.live.text ? {} : { lastEventAt: Date.now() }),
        },
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
      return { ...model, live: { ...live, text: event.mode === 'replace' ? event.text : live.text + event.text, lastEventAt: Date.now() } };
    }
    case 'activity': {
      const live = model.live ?? freshLive('thinking');
      return { ...model, live: { ...live, activities: upsertActivity(live.activities, event.event), thought: latestThought(live.thought, event.event), lastEventAt: Date.now() } };
    }
    case 'phase':
      return model.live ? { ...model, live: { ...model.live, phase: stripAnsi(event.message), lastEventAt: Date.now() } } : model;
    case 'plan':
      return { ...model, plan: event.entries.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })) };
    case 'usage':
      return { ...model, turnUsage: { ...event.usage } };
    case 'approval-request':
      if (model.approvals.some((item) => item.id === event.id)) return model;
      return {
        ...model,
        approvals: [...model.approvals, {
          id: event.id, title: stripAnsi(event.title),
          ...(event.detail ? { detail: stripAnsi(event.detail) } : {}),
          ...(event.rule ? { rule: event.rule } : {}),
          hasDiff: Boolean(event.preview?.diff) || Boolean(diffInDetail(event.detail)),
        }],
      };
    case 'notice':
    case 'note':
      return withNote(model, { kind: 'notice', level: 'info', text: stripAnsi(event.message) });
    case 'turn-error':
      return withNote(model, { kind: 'notice', level: 'error', text: stripAnsi(event.message) });
    case 'submission':
      return { ...model, submissions: model.submissions.map((item) => (item.id === event.id ? { ...item, disposition: event.disposition } : item)) };
    case 'shutdown':
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
  const traces = activities.length && model.turnUserIndex !== undefined
    ? [...model.traces.filter((trace) => trace.userIndex !== model.turnUserIndex), {
      userIndex: model.turnUserIndex, activities, startedAt: model.live?.startedAt ?? Date.now(), endedAt: Date.now(),
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
    case 'turn-end':
      return model;
    case 'busy':
      return { ...model, busy: event.label };
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
      return { ...model, accountUsage: [event.label, event.reset].filter(Boolean).join(' · ') || undefined };
    case 'closed':
      return event.sessionId === model.sessionId ? freshFor(model) : model;
    default:
      return model;
  }
}

export function answeredApproval(model: ChatModel, id: string): ChatModel {
  return { ...model, approvals: model.approvals.filter((item) => item.id !== id) };
}

export function typedDuringTurn(model: ChatModel, id: string, text: string): ChatModel {
  return { ...model, submissions: [...model.submissions, { id, text }] };
}

export function localNote(model: ChatModel, note: Omit<Note, 'after'>): ChatModel {
  return withNote(model, note);
}
