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
import type { IdeEvent, IdeProvider, WorkerEvent } from './protocol';
import { formatOutput } from './format';
import { modelLabel } from './webview/format';
import { stripAnsi } from './text';
import { resumed } from './model/clock';
import { withNote } from './model/notes';
import { applySession, freshFor, NO_TRANSIENT } from './model/session';
import { applyWorkerEvent } from './model/worker-events';
import type { ChatModel } from './model/types';

// The model is split by what it knows: model/types.ts the shapes, model/activity.ts
// the live turn's rows, model/worker-events.ts its reducer, model/traces.ts the
// finished turn. This file keeps the chat-level state and what the page asks of it.
export type * from './model/types';
export { liveChildren } from './model/activity';
export { liveElapsedMs } from './model/clock';
export { answeredApproval } from './model/approvals';
export { turnMarks, turnNoticeNotes } from './model/marks';
export { applySession, emptyModel, NO_TRANSIENT } from './model/session';
export { withNote } from './model/notes';

export function conversationAttention(id: string, open: ReadonlyArray<{ sessionId?: string; approvals: number; unread: boolean }>): 'waiting' | 'unread' | undefined {
  const showing = open.filter((chat) => chat.sessionId === id);
  if (showing.some((chat) => chat.approvals > 0)) return 'waiting';
  if (showing.some((chat) => chat.unread)) return 'unread';
  return undefined;
}

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
  if (model.providerName) return model.providerName;
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

/** The bridge went away and did not come back: nothing is running on this
 * screen any more, and the prompt this window was showing as pending is not
 * pending (the next snapshot's transcript, or its absence, says what became
 * of it). */
export function connectionLost(model: ChatModel, patch: Partial<ChatModel> = {}): ChatModel {
  return {
    ...model, ...patch, ...NO_TRANSIENT, running: false, live: undefined, ownTurn: undefined, turnUserIndex: undefined,
    // Only a live bridge ends these: a 'signing in…' or busy label and the queue it was holding.
    busy: undefined, signIn: undefined, queued: [],
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

export function applyEvent(model: ChatModel, event: IdeEvent): ChatModel {
  switch (event.type) {
    case 'ready':
      return {
        ...model, connection: 'ready', version: event.version, connectionError: undefined, remedy: undefined,
        revision: typeof event.revision === 'number' ? event.revision : 1,
      };
    case 'session':
      return applySession(model, event.session, event.account, event.modelLabel, { id: event.providerId, name: event.providerName });
    case 'worker':
      return applyWorkerEvent(model, event.sessionId, event.event, event.level);
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
      const shown = formatOutput(event.payload, event.formatted);
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
  return enterAgainSends(model.queued.filter((item) => !item.command).map((item) => ({
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

export function typedDuringTurn(model: ChatModel, id: string, text: string): ChatModel {
  return { ...model, submissions: [...model.submissions, { id, text }] };
}
