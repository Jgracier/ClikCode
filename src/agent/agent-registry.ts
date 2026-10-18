/** The record of a session's background agents, on disk. It is what lets a new
 * worker, a new turn or `/agents` see agents an earlier one started, and what
 * finds an agent's work after a worker that died without winding it down:
 * its worktree is committed to its branch and the agent reported interrupted
 * (reconcileAgents). One small JSON file per session. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { finishAgentWorktree, type AgentWorktree } from './worktree.js';

type AgentRecordStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'interrupted';

interface AgentRecord {
  id: string;
  label: string;
  status: AgentRecordStatus;
  startedAt: number;
  endedAt?: number;
  /** The worker process that runs it. */
  pid: number;
  worktree?: AgentWorktree;
  summary?: string;
}

const file = (stateDir: string, sessionId: string): string => path.join(stateDir, 'agent-registry', `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function readAgentRecords(stateDir: string, sessionId: string): AgentRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(stateDir, sessionId), 'utf8'));
    return Array.isArray(parsed) ? parsed as AgentRecord[] : [];
  } catch {
    // fail-open-ok: no record yet (or an unreadable one) means no agents are known.
    return [];
  }
}

function write(stateDir: string, sessionId: string, records: readonly AgentRecord[]): void {
  try {
    const target = file(stateDir, sessionId);
    mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(records));
    renameSync(temp, target);
  } catch { /* fail-open-ok: the record is for finding work after a crash; the agent itself does not depend on it */ }
}

function update(stateDir: string, sessionId: string, id: string, change: (record: AgentRecord) => AgentRecord): void {
  const records = readAgentRecords(stateDir, sessionId);
  const at = records.findIndex((record) => record.id === id);
  if (at < 0) return;
  records[at] = change(records[at]!);
  write(stateDir, sessionId, records);
}

export function agentRecordStarted(stateDir: string, sessionId: string, start: { id: string; label: string; startedAt: number }): void {
  const records = readAgentRecords(stateDir, sessionId).filter((record) => record.id !== start.id);
  records.push({ ...start, status: 'running', pid: process.pid });
  write(stateDir, sessionId, records);
}

export function agentRecordUpdated(stateDir: string, sessionId: string, id: string, patch: Partial<Pick<AgentRecord, 'worktree'>>): void {
  update(stateDir, sessionId, id, (record) => ({ ...record, ...patch }));
}

export function agentRecordEnded(stateDir: string, sessionId: string, id: string, status: AgentRecordStatus, summary?: string): void {
  update(stateDir, sessionId, id, (record) => ({ ...record, status, endedAt: Date.now(), ...(summary ? { summary } : {}) }));
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Agents the record says were running under a worker that is gone: their
 * work is committed to the branch, they are marked interrupted, and what
 * the model should be told about each is returned. */
export async function reconcileAgents(stateDir: string, sessionId: string): Promise<Array<{ id: string; label: string; report: string }>> {
  const reports: Array<{ id: string; label: string; report: string }> = [];
  for (const record of readAgentRecords(stateDir, sessionId)) {
    if (record.status !== 'running' || record.pid === process.pid || alive(record.pid)) continue;
    let report = 'The worker that ran it ended before it finished.';
    if (record.worktree && existsSync(record.worktree.root)) {
      report += ` ${await finishAgentWorktree(record.worktree, `Agent (interrupted): ${record.label}`.slice(0, 200))}`;
    } else if (record.worktree) report += ` Its work, if any, is on branch ${record.worktree.branch}.`;
    agentRecordEnded(stateDir, sessionId, record.id, 'interrupted', report.slice(0, 2000));
    reports.push({ id: record.id, label: record.label, report });
  }
  return reports;
}
