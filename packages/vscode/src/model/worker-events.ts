/** A worker's event applied to the chat: the live turn's reducer. */
import { asFileDiffs } from '../../../../src/agent/line-diff';
import { backgroundWorkOf } from '../../../../src/harness/protocol/background-agents';
import { isApprovalWaitPhase } from '../../../../src/harness/protocol/turn-flow';
import { failureText } from '../../../../src/harness/protocol/stderr-line';
import { isUsageExhaustedMessage } from '../../../../src/turn/usage-exhausted';
import { noticeLevel, stripAnsi } from '../text';
import type { WorkerEvent } from '../protocol';
import { applyActivity, cleanDiff, freshLive, liveBackground, rebaseOffsets, settled, settledCalls, stampAfter, takeSeq, withoutPhase } from './activity';
import { answeredApproval, askedAt } from './approvals';
import { applySnapshot } from './snapshot';
import { NO_TRANSIENT } from './session';
import { withNote } from './notes';
import { endTurn } from './traces';
import type { ChatModel } from './types';


export function applyWorkerEvent(model: ChatModel, sessionId: string, event: WorkerEvent, level?: 'info' | 'warning' | 'error'): ChatModel {
  if (model.sessionId && sessionId !== model.sessionId) return model;
  switch (event.type) {

    case 'snapshot':
      return applySnapshot(model, event);

    case 'waiting-start':
      return {
        ...model, running: true, turnUserIndex: model.messages.length,
        // A turn another window started (the phone's, a terminal's): this panel never saw the message sent, and until the turn
        // is saved nothing else says what was asked. The worker names it here. A turn this panel sent holds what the user
        // typed already (the line, not the text a command expanded to) and keeps it.
        ...(event.prompt !== undefined && !model.ownTurn && !model.pendingPrompt ? { pendingPrompt: event.prompt } : {}),
        live: { ...freshLive(stripAnsi(event.message)), ...liveBackground(model.background) }, plan: [], submissions: [],
        turnUsage: undefined, stopPending: undefined,
      };
    case 'waiting-stop':
      // Submissions stay: the messages the turn saved are not here yet, and a
      // steered one would leave the screen for the frames in between. The
      // snapshot that carries them settles them (applySession).
      return { ...endTurn(model, event.stopped === true), pendingPrompt: undefined, approvals: [], stopPending: undefined, steerable: false };
    case 'steerable':
      return { ...model, steerable: event.value };
    // The worker accepted a Stop: the one source of "stopping".
    case 'stopping':
      if (model.live?.stopping || model.stopPending) return model;
      return model.running ? { ...model, live: { ...(model.live ?? freshLive('thinking')), stopping: true } } : { ...model, stopPending: true };
    // A Stop that ended nothing: no longer stopping.
    case 'stop-done': {
      if (!model.live) return { ...model, stopPending: undefined };
      const { stopping: _stopping, ...live } = model.live;
      return { ...model, stopPending: undefined, live };
    }
    // The worker could not take the submit on: the echoed prompt is not pending.
    case 'submit-rejected':
      return model.running ? model : { ...model, ownTurn: undefined, pendingPrompt: undefined, stopPending: undefined };
    case 'delta': {
      // A Stop is in flight: what the vendor still streams is not drawn.
      if (model.live?.stopping) return model;
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
      if (model.live?.stopping) return model;
      const live = model.live ?? freshLive('thinking');
      return { ...model, live: { ...applyActivity(withoutPhase(live), event.event), activeAt: Date.now() } };
    }
    case 'background': {
      // A level: the vendor's own count of what still runs, by kind.
      const live = model.live ?? freshLive('thinking');
      const background = backgroundWorkOf({ background: event.work, pendingBackground: event.pending });
      const { pendingBackground: _held, background: _work, ...rest } = live;
      return { ...model, background, live: { ...rest, ...liveBackground(background) } };
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
    case 'note':
      // The terminal colours its notes: yellow for an account switch or a
      // limit, red for a failure. The colour is the level.
      return withNote(model, {
        kind: 'notice', level: level ?? noticeLevel(event.message), text: stripAnsi(event.message),
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.responseOffset !== undefined ? { offset: event.responseOffset } : {}),
      });
    case 'turn-error': {
      // The worker has ended this attempt. A shell whose completion never
      // reached it must stop animating now, even before waiting-stop arrives.
      const failed = model.live ? { ...model, live: { ...model.live, activities: settledCalls(model.live.activities, true) } } : model;
      // The turn's own note already says it.
      if (event.said) return failed;
      // The whole cause, as the terminal's note shows it: the notice wraps.
      const msg = failureText(stripAnsi(event.message));
      // Exhaustion is an outcome, not a fault — show it as informational chat
      // text rather than a red error banner so it reads as part of the flow.
      const exhausted = isUsageExhaustedMessage(msg);
      return withNote(failed, { kind: 'notice', level: exhausted ? 'info' : 'error', text: msg });
    }
    case 'submission': {
      const submissions = model.submissions.map((item) => (item.id === event.id ? { ...item, disposition: event.disposition } : item));
      if (event.disposition !== 'steered') return { ...model, submissions };
      // Taken into the turn: out of the queue now, and in the turn where it
      // was acknowledged -- not a row at the bottom until a snapshot says so.
      const queued = model.queued.filter((item) => item.id !== event.id);
      const sent = model.submissions.find((item) => item.id === event.id);
      const live = model.live;
      if (!live || !sent || live.steers.some((steer) => steer.id === event.id)) return { ...model, submissions, queued };
      const { seq, seen } = takeSeq(live, event.seq);
      return {
        ...model, submissions, queued,
        live: { ...live, seen, steers: [...live.steers, { id: event.id, text: sent.text, offset: Math.min(event.responseOffset ?? live.text.length, live.text.length), seq }] },
      };
    }
    case 'shutdown':
      // An idle worker retiring (a newer build, an idle timeout) is invisible:
      // the bridge attaches to its replacement. Only a cut-off turn is news.
      if (!model.running) return model;
      return { ...endTurn(withNote(model, { kind: 'notice', level: 'info', text: 'Stopped' })), ...NO_TRANSIENT };
    default:
      // suspend/resume, sign-in-request (the bridge handles it), restore-draft
      // (arrives separately) and anything a newer worker says.
      return model;
  }
}
