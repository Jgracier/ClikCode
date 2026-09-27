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
import type { HarnessActivityEvent, HarnessSession, IdeEvent, WorkerEvent } from './protocol';
import { formatOutput } from './format';
import { stripAnsi } from './text';

export interface Activity {
  key: string;
  kind: HarnessActivityEvent['kind'];
  label: string;
  category?: string;
  output?: string[];
  diff?: { removed: string[]; added: string[] };
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

export interface ChatModel {
  connection: 'starting' | 'ready' | 'stopped' | 'error';
  connectionError?: string;
  /** Offer to install ClikCode, not merely report. */
  installHint?: boolean;
  version?: string;
  sessionId?: string;
  title?: string;
  harness?: string;
  model?: string;
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
  live?: { text: string; waitingLabel: string; phase?: string; activities: Activity[] };
  plan: Array<{ content: string; status?: string }>;
  turnUsage?: { inputTokens?: number; outputTokens?: number };
  approvals: Approval[];
  busy?: string;
  /** A message typed during the turn and what became of it. */
  submissions: Array<{ id: string; text: string; disposition?: string }>;
}

export function emptyModel(): ChatModel {
  return { connection: 'starting', messages: [], notes: [], queued: [], running: false, plan: [], approvals: [], submissions: [] };
}

const MAX_NOTES = 50;
const MAX_ACTIVITIES = 200;

function withNote(model: ChatModel, note: Omit<Note, 'after'>): ChatModel {
  return { ...model, notes: [...model.notes, { ...note, after: model.messages.length }].slice(-MAX_NOTES) };
}

export function applySession(model: ChatModel, session: HarnessSession, account?: string): ChatModel {
  if (model.sessionId && model.sessionId !== session.id) model = { ...emptyModel(), connection: model.connection, ...(model.version ? { version: model.version } : {}) };
  const pending = session.pendingTurn;
  return {
    ...model,
    sessionId: session.id,
    title: session.name,
    harness: session.route === 'gateway' ? 'ClikDeploy Gateway' : session.route === 'clikcode-local' ? 'ClikCode Local' : session.nativeHarness,
    model: session.reported?.model ?? session.model ?? undefined,
    account,
    effort: session.route === 'gateway' ? undefined : session.effort || undefined,
    permissions: session.route === 'gateway' ? undefined : session.permissionMode ?? 'ask',
    route: session.route,
    workspace: session.workspace,
    messages: session.messages ?? [],
    queued: (session.queuedTurns ?? []).map((item) => ({ id: item.id, text: item.text, command: item.kind === 'command' })),
    // The worker's journal of the running turn has the prompt from here on.
    pendingPrompt: pending?.prompt ?? (model.running ? model.pendingPrompt : undefined),
  };
}

function upsertActivity(activities: Activity[], event: HarnessActivityEvent): Activity[] {
  const activity: Activity = {
    key: event.id ?? `${activities.length}`,
    kind: event.kind,
    label: stripAnsi(event.label),
    ...(event.category ? { category: event.category } : {}),
    ...(event.output?.length ? { output: event.output.map(stripAnsi) } : {}),
    ...(event.diff ? { diff: { removed: [...event.diff.removed], added: [...event.diff.added] } } : {}),
  };
  if (event.parentId) return activities;
  if (event.id) {
    const index = activities.findIndex((item) => item.key === event.id);
    if (index >= 0) return activities.map((item, position) => (position === index ? { ...item, ...activity, label: activity.label || item.label } : item));
  }
  return [...activities, activity].slice(-MAX_ACTIVITIES);
}

export function applyWorkerEvent(model: ChatModel, sessionId: string, event: WorkerEvent): ChatModel {
  if (model.sessionId && sessionId !== model.sessionId) return model;
  switch (event.type) {
    case 'snapshot': {
      const next = applySession(model, event.session, event.account);
      // The worker attaches `live` to every snapshot while a turn runs, so
      // one without it says nothing is running there.
      if (!event.live) return model.live ? { ...next, running: false, live: undefined, pendingPrompt: undefined } : next;
      return {
        ...next,
        running: true,
        live: { activities: next.live?.activities ?? [], ...next.live, text: event.live.text, waitingLabel: stripAnsi(event.live.waitingLabel) },
      };
    }
    case 'waiting-start':
      return { ...model, running: true, live: { text: '', waitingLabel: stripAnsi(event.message), activities: [] }, plan: [], submissions: [] };
    case 'waiting-stop':
      return { ...model, running: false, live: undefined, pendingPrompt: undefined, approvals: [], submissions: [] };
    case 'delta': {
      const live = model.live ?? { text: '', waitingLabel: 'thinking', activities: [] };
      return { ...model, live: { ...live, text: event.mode === 'replace' ? event.text : live.text + event.text } };
    }
    case 'activity': {
      const live = model.live ?? { text: '', waitingLabel: 'thinking', activities: [] };
      return { ...model, live: { ...live, activities: upsertActivity(live.activities, event.event) } };
    }
    case 'phase':
      return model.live ? { ...model, live: { ...model.live, phase: stripAnsi(event.message) } } : model;
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
          hasDiff: Boolean(event.preview?.diff),
        }],
      };
    case 'notice':
      return withNote(model, { kind: 'notice', level: 'info', text: stripAnsi(event.message) });
    case 'turn-error':
      return withNote(model, { kind: 'notice', level: 'error', text: stripAnsi(event.message) });
    case 'submission':
      return { ...model, submissions: model.submissions.map((item) => (item.id === event.id ? { ...item, disposition: event.disposition } : item)) };
    case 'shutdown':
      return { ...withNote(model, { kind: 'notice', level: 'warning', text: `The conversation's worker stopped: ${event.reason}` }), running: false, live: undefined, approvals: [] };
    default:
      // suspend/resume, sign-in-request (the bridge handles it), restore-draft
      // (arrives separately) and anything a newer worker says.
      return model;
  }
}

export function applyEvent(model: ChatModel, event: IdeEvent): ChatModel {
  switch (event.type) {
    case 'ready':
      return { ...model, connection: 'ready', version: event.version, connectionError: undefined, installHint: undefined };
    case 'session':
      return applySession(model, event.session, event.account);
    case 'worker':
      return applyWorkerEvent(model, event.sessionId, event.event);
    case 'turn-start':
      if (model.sessionId && event.sessionId !== model.sessionId) return model;
      return { ...model, running: true, pendingPrompt: event.prompt, queued: model.queued.filter((item) => item.id !== event.queuedTurnId) };
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
      return event.sessionId === model.sessionId ? { ...emptyModel(), connection: model.connection, ...(model.version ? { version: model.version } : {}) } : model;
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
