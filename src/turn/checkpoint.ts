/** Durable, provider-neutral representation of a turn that has started but
 * has not reached a successful provider completion yet. */

import type { HarnessActivityEvent } from '../harness/prompter.js';
import { commandIsReadOnly } from '../agent/command-classifier.js';
import { isAgentToolName } from '../harness/protocol/tools.js';
import type { HarnessSession } from '../session/model.js';
import { normalizeImportedTranscript } from './failover-prompt.js';
import type { LiveTurnSubmission } from './live-input.js';

type Message = NonNullable<HarnessSession['messages']>[number];

/** The persisted pending turn plus the replay hints this module records. The
 * extra fields are optional and JSON-serializable, so they ride along in the
 * same session state without a schema change. */
export type PendingTurnWithHints = NonNullable<HarnessSession['pendingTurn']> & {
  /** Files the interrupted turn is known to have started changing. */
  touchedFiles?: string[];
  /** Sticky: some recorded activity may have changed the workspace. Kept
   * separately because `activities` is a rolling window of the newest 20. */
  mutatingActivity?: boolean;
};

const MAX_TOUCHED_FILES = 40;

const READ_ONLY_TOOL = /^(?:read|view|open|cat|ls|list(?:_?(?:dir|directory|files))?|glob|grep|search|find|fetch|web_?(?:fetch|search)|(?:notebook|file)_?read|read_?(?:file|many_files|notebook)|codebase_?search|semantic_?search|todo_?(?:read|write)|update_?(?:todos?|plan)|think|toolsearch|get_\w+|describe_\w+|lsp\w*)$/i;
const CODE_CHANGE_TOOL = /^(?:edit|multi_?edit|write|create|patch|apply_?patch|str_?replace\w*|replace|notebook_?edit|(?:edit|write|create|delete|update|replace_in)_?file|delete|remove|rename|move)$/i;
/** A tool row as formatToolRow writes it (harness/protocol/tools.ts): a verb
 * and its target, `$ command`, or `server › tool args`. */
const TOOL_ROW = /^(Read|List|Grep|Glob|Search|Fetch|Web search|Edit|Write|Agent) ([\s\S]+)$/;
const MUTATING_ROW = /^(?:Edit|Write|Agent)$/;
const MCP_ROW = /^\S+ › ([\w.-]+)/;

/** Whether an activity label describes something that cannot have changed the
 * workspace. Deliberately conservative: anything unrecognised is NOT read-only,
 * because the cost of a wrong "safe" is silently re-running edits. */
export function activityLabelIsReadOnly(label: string): boolean {
  const text = label.trim();
  if (!text) return true;
  if (text.startsWith('$ ')) return commandIsReadOnly(text.slice(2));
  const row = TOOL_ROW.exec(text);
  if (row) return !MUTATING_ROW.test(row[1]!);
  const mcp = MCP_ROW.exec(text);
  if (mcp) return READ_ONLY_TOOL.test(mcp[1]!) && !CODE_CHANGE_TOOL.test(mcp[1]!);
  // Rows recorded before the shared format: `name(detail)`.
  const call = /^([\w.:-]+)\(([\s\S]*)\)$/.exec(text);
  const name = (call?.[1] ?? text).replace(/^mcp__\w+?__|^\w+__/, '');
  if (/^(?:bash|shell|sh|exec|execute|run|terminal|command|run_?(?:shell_?)?command|run_?terminal_?cmd|execute_?command|developer__shell)$/i.test(call?.[1] ?? '') || /shell$/i.test(call?.[1] ?? '')) {
    return commandIsReadOnly(call?.[2] ?? '');
  }
  if (call || /^[\w.:-]+$/.test(text)) return READ_ONLY_TOOL.test(name) && !CODE_CHANGE_TOOL.test(name);
  // A bare command line (older Codex rows were the command itself).
  return commandIsReadOnly(text);
}

/** Files an activity is changing, when its label or diff says so. */
function touchedFilesFromActivity(event: HarnessActivityEvent): string[] {
  const text = event.label.trim();
  const row = TOOL_ROW.exec(text);
  if (row && /^(?:Edit|Write)$/.test(row[1]!)) {
    // `Edit a.ts (3 changes)`, `Edit a.ts, b.ts +2 more`: the paths only.
    return row[2]!.replace(/ \([^)]*\)$/, '').replace(/ \+\d+ more$/, '').split(', ').map((file) => file.trim()).filter(Boolean);
  }
  const call = /^([\w.:-]+)\(([\s\S]*)\)$/.exec(text);
  if (!call) return [];
  const name = call[1]!.replace(/^mcp__\w+?__|^\w+__/, '');
  const target = call[2]!.trim();
  if (!target || (!event.diff && !CODE_CHANGE_TOOL.test(name))) return [];
  // toolLabel() also put commands/patterns/urls in this slot.
  if (/\s/.test(target) && !/[\\/]/.test(target)) return [];
  return [target];
}

function activitySummary(activities: readonly string[], touchedFiles: readonly string[] = []): string {
  const files = touchedFiles.length ? ` Files it started changing: ${touchedFiles.join(', ')}.` : '';
  return `Interrupted turn activity: ${activities.join('; ')}.${files} Inspect the current workspace before continuing.`;
}

/** Steer offsets index the STREAMED response. When a different final text is
 * about to replace it, re-anchor each offset so the steer still lands where
 * the user interjected:
 *  1. inside the prefix both texts share -> unchanged;
 *  2. otherwise, where the streamed text just before the steer reappears in
 *     the final text (the usual case: same prose, different whitespace);
 *  3. otherwise 0. The final text is then something the model wrote after
 *     hearing the steer (a vendor's "final answer only" result), so the steer
 *     precedes it. It is never placed after the reply: a transcript ending in
 *     a user message reads as an unanswered prompt to the next provider. */
function remapSteerOffset(streamed: string, final: string, offset: number): number {
  const clamped = Math.max(0, Math.min(streamed.length, offset));
  if (streamed === final || clamped === 0) return Math.min(clamped, final.length);
  let shared = 0;
  const limit = Math.min(streamed.length, final.length);
  while (shared < limit && streamed.charCodeAt(shared) === final.charCodeAt(shared)) shared += 1;
  if (clamped <= shared) return clamped;
  const context = streamed.slice(Math.max(0, clamped - 48), clamped).trim();
  if (context.length >= 8) {
    const at = final.indexOf(context);
    if (at >= 0 && final.indexOf(context, at + 1) < 0) return at + context.length;
  }
  return 0;
}

/** Materialize an in-flight turn without mutating the session. This is used by
 * rendering, history, and provider handoff so a process/provider failure never
 * makes submitted work disappear from the portable conversation. */
export function sessionTranscriptMessages(session: HarnessSession): Message[] {
  // Sessions written before rehydration prompts were normalized on import
  // still hold one verbatim; nothing should ever render or replay it.
  const messages = normalizeImportedTranscript(session.messages ?? []);
  const pending = session.pendingTurn;
  if (!pending) return messages;
  messages.push({ role: 'user', content: pending.prompt });
  const response = pending.response ?? '';
  let responseOffset = 0;
  for (const steer of [...(pending.steers ?? [])].sort((left, right) => (left.responseOffset ?? 0) - (right.responseOffset ?? 0))) {
    const steerOffset = Math.max(responseOffset, Math.min(response.length, steer.responseOffset ?? 0));
    const beforeSteer = response.slice(responseOffset, steerOffset);
    if (beforeSteer.trim()) messages.push({ role: 'assistant', content: beforeSteer });
    messages.push({ role: 'user', content: steer.text });
    responseOffset = steerOffset;
  }
  const remaining = response.slice(responseOffset);
  if (remaining.trim()) messages.push({ role: 'assistant', content: remaining });
  else if (!response.trim() && pending.activities?.length) messages.push({ role: 'assistant', content: activitySummary(pending.activities, (pending as PendingTurnWithHints).touchedFiles) });
  return messages;
}

/** The conversation as it stands BEFORE the turn a window is about to follow.
 *
 * sessionTranscriptMessages folds an in-flight journal in as if it had ended
 * -- its prompt, then "Interrupted turn activity: …" -- which is right for a
 * turn nothing is running. For the turn being followed it drew that turn
 * twice: once folded in, once live beneath it, on every switch into a
 * conversation mid-turn. `runningPrompt` is the followed turn's prompt; a
 * journal for any other prompt is an older interrupted turn and stays. */
export function settledTranscriptMessages(session: HarnessSession, runningPrompt?: string): Message[] {
  const pending = session.pendingTurn;
  const followed = pending && (runningPrompt === undefined || pending.prompt.trim() === runningPrompt.trim());
  return sessionTranscriptMessages(followed ? { ...session, pendingTurn: undefined } : session);
}

/** What the followed turn is doing right now, from its journal: the call it
 * started last, while nothing has completed it. A window that joins a turn
 * mid-way sees only what happens after it joined, so a twenty-minute command
 * already running showed as a bare "thinking" -- which reads as stuck. */
export function runningActivityLabel(pending: HarnessSession['pendingTurn']): string | undefined {
  const last = pending?.activities?.at(-1);
  return last?.startsWith('started ') ? `running ${last.slice('started '.length)}` : undefined;
}

/** Starting another turn commits an older interrupted checkpoint first. */
export function beginPendingTurn(session: HarnessSession, prompt: string, now: string): void {
  if (session.pendingTurn) session.messages = sessionTranscriptMessages(session);
  session.pendingTurn = { prompt, startedAt: now, updatedAt: now, outputStarted: false };
  session.updatedAt = now;
}

export function updatePendingResponse(
  session: HarnessSession, text: string, mode: 'append' | 'replace', now: string,
): void {
  const pending = session.pendingTurn;
  if (!pending || (!text && mode === 'append')) return;
  if (mode === 'replace' && pending.steers?.length && (pending.response ?? '') !== text) {
    const streamed = pending.response ?? '';
    pending.steers = pending.steers.map((steer) => ({ ...steer, responseOffset: remapSteerOffset(streamed, text, steer.responseOffset ?? 0) }));
  }
  if (!text) delete pending.response;
  else pending.response = mode === 'replace' ? text : `${pending.response ?? ''}${text}`;
  pending.outputStarted = Boolean(text || pending.activities?.length);
  pending.updatedAt = now;
  session.updatedAt = now;
}

/** Which sub-agents are running, kept by call id: a start adds one, its own
 * completion removes it, and a call made INSIDE one (parentId) becomes the
 * step it is on. */
function trackSubagent(pending: NonNullable<HarnessSession['pendingTurn']>, event: HarnessActivityEvent, now: string): void {
  const running = pending.subagents ?? [];
  if (event.parentId) {
    const parent = running.find((agent) => agent.id === event.parentId);
    if (parent && event.kind === 'tool-start') { parent.step = event.label; parent.stepAt = now; }
    return;
  }
  if (!event.id) return;
  // The same test the live row uses (tui/render/waiting.ts liveWaitKind): a
  // shell command is never an agent, whatever its text starts with.
  const isAgent = event.agent || (event.category !== 'run' && isAgentToolName(event.label));
  if (event.kind === 'tool-start' && isAgent && !running.some((agent) => agent.id === event.id)) {
    pending.subagents = [...running, { id: event.id, label: event.label, startedAt: now }];
  } else if ((event.kind === 'tool-done' || event.kind === 'tool-error') && running.some((agent) => agent.id === event.id)) {
    const left = running.filter((agent) => agent.id !== event.id);
    if (left.length) pending.subagents = left;
    else delete pending.subagents;
  }
}

export function recordPendingActivity(session: HarnessSession, event: HarnessActivityEvent, now: string): void {
  const pending = session.pendingTurn;
  if (!pending || event.kind === 'thinking') return;
  // Before the de-duplication below, which would skip a repeated step.
  trackSubagent(pending, event, now);
  const hints = pending as PendingTurnWithHints;
  // Hints first: the de-duplication below must not skip them, and they must
  // outlive the 20-entry activity window.
  for (const touched of touchedFilesFromActivity(event)) {
    if (!hints.touchedFiles?.includes(touched)) hints.touchedFiles = [...(hints.touchedFiles ?? []), touched].slice(-MAX_TOUCHED_FILES);
  }
  // A completion is reported under a generic label by some vendors ("tool");
  // its start already carried the real identity.
  if (Boolean(event.diff) || (!(event.kind !== 'tool-start' && event.label === 'tool') && !activityLabelIsReadOnly(event.label))) hints.mutatingActivity = true;
  const verb = event.kind === 'tool-error' ? 'failed'
    : event.kind === 'tool-done' ? 'completed' : event.kind === 'tool-start' ? 'started' : 'thinking';
  const summary = `${verb} ${event.label}`.trim();
  if (!summary || pending.activities?.[pending.activities.length - 1] === summary) return;
  pending.activities = [...(pending.activities ?? []).slice(-19), summary];
  pending.outputStarted = true;
  pending.updatedAt = now;
  session.updatedAt = now;
}

export function recordPendingSteer(
  session: HarnessSession, text: string, submittedAt: string, responseOffset: number, now: string, id?: string,
): void {
  const pending = session.pendingTurn;
  if (!pending || !text.trim()) return;
  pending.steers = [...(pending.steers ?? []), {
    text: text.trim(), submittedAt, responseOffset: Math.max(0, responseOffset), ...(id ? { id } : {}),
  }];
  pending.updatedAt = now;
  session.updatedAt = now;
}

export function enqueueSessionTurn(session: HarnessSession, submission: LiveTurnSubmission, now: string): void {
  if ((session.queuedTurns ?? []).some((item) => item.id === submission.id)) return;
  session.queuedTurns = [...(session.queuedTurns ?? []), submission];
  session.updatedAt = now;
}

export function consumeSessionTurn(session: HarnessSession, id: string): boolean {
  const queued = session.queuedTurns ?? [];
  const next = queued.filter((item) => item.id !== id);
  if (next.length === queued.length) return false;
  if (next.length) session.queuedTurns = next;
  else delete session.queuedTurns;
  return true;
}

/** The answer that is kept: what the user watched arrive, unless the vendor's
 * final report genuinely has more.
 *
 * A turn's text has two sources. The stream is what was on screen; the
 * vendor's final record (`result`, `response`, ...) is what it reports at the
 * end. They are often NOT the same text: Claude-shaped CLIs report only the
 * LAST text block in `result`, dropping everything said before the final tool
 * call. Saving that report replaced the streamed answer at the end of the
 * turn, and every paragraph before the last tool call flashed on screen and
 * vanished.
 *
 * So the stream wins, and the report is used only where it is strictly
 * better: nothing streamed at all (a text-mode CLI, a transport with no
 * deltas), or it contains everything that streamed and more (a trailing chunk
 * never arrived). When they simply differ, what the user watched is kept --
 * a saved answer that differs from the one on screen is exactly the flash.
 * Compared with whitespace collapsed, since streams and reports rarely agree
 * on where the blank lines go. */
export function durableAnswer(streamed: string, reported: string): string {
  const stream = streamed.trim();
  const report = reported.trim();
  if (!stream) return report;
  if (!report) return stream;
  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const flatStream = flat(stream);
  const flatReport = flat(report);
  // Everything that was on screen, and more: nothing the user saw is lost.
  if (flatReport.length > flatStream.length && flatReport.includes(flatStream)) return report;
  return stream;
}

export function finishPendingTurn(session: HarnessSession, response: string | undefined, now: string): void {
  if (!session.pendingTurn) return;
  if (response?.trim() || session.pendingTurn.response?.trim()) {
    const pending = session.pendingTurn;
    const streamed = pending.response ?? '';
    const final = durableAnswer(streamed, response ?? '');
    if (pending.steers?.length && streamed !== final) {
      pending.steers = pending.steers.map((steer) => ({ ...steer, responseOffset: remapSteerOffset(streamed, final, steer.responseOffset ?? 0) }));
    }
    pending.response = final;
    pending.outputStarted = true;
  }
  session.messages = sessionTranscriptMessages(session);
  delete session.pendingTurn;
  session.updatedAt = now;
}

export function discardPendingTurn(session: HarnessSession, prompt?: string): boolean {
  if (!session.pendingTurn || (prompt !== undefined && session.pendingTurn.prompt !== prompt)) return false;
  delete session.pendingTurn;
  return true;
}
