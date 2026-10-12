/** In-process memory that outlives a single turn but not the process:
 * which files the model has actually read (the edit guard), background
 * shells, and whether plan mode is still in force. */
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { killProcessTreePortable } from '../harness/transport/spawn.js';

interface FileReadStamp { mtimeMs: number; size: number }

export interface BackgroundShell {
  id: string;
  command: string;
  child: ChildProcess;
  detached: boolean;
  /** Rolling buffer of output not yet handed to the model. */
  unread: string;
  droppedBytes: number;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: number;
  spillPath?: string;
  /** Set when something other than the model stops the shell (the idle
   * worker's ceiling): the model did not ask for it, so it is told. */
  killReason?: string;
}

/** A background shell finished on its own (or was stopped by something other
 * than the model). Held on the session until the agent loop hands it to the
 * model: at the top of the next step of a running turn, or, when no turn is
 * running, as the prompt of a follow-up turn the worker starts. */
export interface ShellNotification {
  /** What happened: the shell exited (the default), a monitor's command printed
   * lines (`tail` holds them), or a scheduled wakeup fired (`shellId` is its
   * id, `command` the reason, `tail` the prompt to carry out). */
  kind?: 'output' | 'wakeup';
  shellId: string;
  command: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** The last of the output the model has not read yet, already redacted. */
  tail: string;
  reason?: string;
  at: number;
}

/** A prompt the model scheduled for itself (schedule_wakeup). Held in this
 * process only: it does not outlive the worker that holds it. */
export interface PendingWakeup {
  id: string;
  prompt: string;
  reason: string;
  /** Epoch ms it fires. */
  at: number;
  timer: NodeJS.Timeout;
}

export interface HarnessSessionState {
  readonly sessionId: string;
  readonly readFiles: Map<string, FileReadStamp>;
  readonly shells: Map<string, BackgroundShell>;
  plan: { active: boolean; approvedPlan?: string };
  /** A question ask_user put to the user: the loop ends the turn with it, and
   * the user's next message is the answer. */
  pendingQuestion?: string;
  nextShellNumber: number;
  readonly wakeups: Map<string, PendingWakeup>;
  nextWakeupNumber: number;
  /** The "no sandbox installed" notice has been given (sandbox.ts): once a session. */
  sandboxNoticeShown?: boolean;
  /** Finished background shells the model has not been told about yet. */
  readonly notifications: ShellNotification[];
  /** Called after each notification is queued. The worker sets it to start a
   * follow-up turn when none is running; a running turn needs no call, it
   * drains the queue before its next step. */
  onNotification?: () => void;
}

const sessions = new Map<string, HarnessSessionState>();

export function sessionState(stateDir: string, sessionId: string): HarnessSessionState {
  const key = `${path.resolve(stateDir)}\0${sessionId}`;
  let state = sessions.get(key);
  if (!state) {
    state = { sessionId, readFiles: new Map(), shells: new Map(), plan: { active: false }, nextShellNumber: 1, wakeups: new Map(), nextWakeupNumber: 1, notifications: [] };
    sessions.set(key, state);
  }
  return state;
}

export function queueShellNotification(state: HarnessSessionState, notification: ShellNotification): void {
  state.notifications.push(notification);
  try { state.onNotification?.(); } catch { /* a listener fault must not lose the notification */ }
}

export function takeShellNotifications(state: HarnessSessionState): ShellNotification[] {
  return state.notifications.splice(0);
}

/** Fires `prompt` at the model after `delayMs`: queued as a notification, so a
 * running turn hears it before its next step and an idle worker starts a
 * follow-up turn with it. */
export function scheduleWakeup(state: HarnessSessionState, request: { prompt: string; reason: string; delayMs: number }): PendingWakeup {
  const id = `wake_${state.nextWakeupNumber++}`;
  const timer = setTimeout(() => {
    state.wakeups.delete(id);
    queueShellNotification(state, { kind: 'wakeup', shellId: id, command: request.reason, tail: request.prompt, at: Date.now() });
  }, request.delayMs);
  timer.unref();
  const wakeup: PendingWakeup = { id, prompt: request.prompt, reason: request.reason, at: Date.now() + request.delayMs, timer };
  state.wakeups.set(id, wakeup);
  return wakeup;
}

/** Cancels every pending wakeup; how many there were. */
export function cancelWakeups(state: HarnessSessionState): number {
  const count = state.wakeups.size;
  for (const wakeup of state.wakeups.values()) clearTimeout(wakeup.timer);
  state.wakeups.clear();
  return count;
}

export function runningShellCount(state: HarnessSessionState): number {
  let running = 0;
  for (const shell of state.shells.values()) if (shell.status === 'running') running++;
  return running;
}

/** One user-role message for the model: the header says which shell, how it
 * ended and what it ran; the tail is what it printed that was never read. */
export function formatShellNotifications(notifications: readonly ShellNotification[]): string {
  return notifications.map((note) => {
    if (note.kind === 'wakeup') return `[scheduled wakeup ${note.shellId}] ${note.command}\n${note.tail}`;
    if (note.kind === 'output') return `[background shell ${note.shellId} output] ${note.command}\n${note.tail.replace(/\s+$/, '')}`;
    const how = note.reason ? `was stopped: ${note.reason}`
      : note.exitCode !== undefined && note.exitCode !== null ? `exited (code ${note.exitCode})`
        : note.signal ? `exited (${note.signal})` : 'exited';
    const tail = note.tail.trim() ? `\n${note.tail.replace(/\s+$/, '')}` : '\n(no unread output)';
    return `[background shell ${note.shellId} ${how}] ${note.command}${tail}`;
  }).join('\n\n');
}

/** Kill background shells and forget the session. Call when a chat closes.
 * Returns what the model was never told: notifications still queued, and a
 * line for each shell this kills, for a caller that can deliver them later
 * (the worker records them in the conversation's durable queue). */
export function disposeSessionState(stateDir: string, sessionId: string, reason = 'the session closed'): ShellNotification[] {
  const key = `${path.resolve(stateDir)}\0${sessionId}`;
  const state = sessions.get(key);
  if (!state) return [];
  state.onNotification = undefined;
  const undelivered = takeShellNotifications(state);
  for (const wakeup of state.wakeups.values()) {
    undelivered.push({ shellId: wakeup.id, command: wakeup.reason, tail: '', reason: 'the session closed before it fired; schedule it again if it is still needed', at: Date.now() });
  }
  cancelWakeups(state);
  for (const shell of state.shells.values()) {
    if (shell.status !== 'running') continue;
    // Marked first, so its close handler does not queue a second notice.
    shell.status = 'killed';
    killProcessTreePortable(shell.child, 'SIGKILL', shell.detached);
    undelivered.push({ shellId: shell.id, command: shell.command, tail: '', reason, at: Date.now() });
  }
  sessions.delete(key);
  return undelivered;
}
