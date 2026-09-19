/** In-process memory that outlives a single turn but not the process:
 * which files the model has actually read (the edit guard), background
 * shells, and whether plan mode is still in force. */
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { killProcessTreePortable } from '../spawn-portable.js';

export interface FileReadStamp { mtimeMs: number; size: number }

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
}

export interface HarnessSessionState {
  readonly sessionId: string;
  readonly readFiles: Map<string, FileReadStamp>;
  readonly shells: Map<string, BackgroundShell>;
  plan: { active: boolean; approvedPlan?: string };
  nextShellNumber: number;
}

const sessions = new Map<string, HarnessSessionState>();

export function sessionState(stateDir: string, sessionId: string): HarnessSessionState {
  const key = `${path.resolve(stateDir)}\0${sessionId}`;
  let state = sessions.get(key);
  if (!state) {
    state = { sessionId, readFiles: new Map(), shells: new Map(), plan: { active: false }, nextShellNumber: 1 };
    sessions.set(key, state);
  }
  return state;
}

/** Kill background shells and forget the session. Call when a chat closes. */
export function disposeSessionState(stateDir: string, sessionId: string): void {
  const key = `${path.resolve(stateDir)}\0${sessionId}`;
  const state = sessions.get(key);
  if (!state) return;
  for (const shell of state.shells.values()) {
    if (shell.status === 'running') killProcessTreePortable(shell.child, 'SIGKILL', shell.detached);
  }
  sessions.delete(key);
}
