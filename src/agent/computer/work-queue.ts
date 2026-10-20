/** The queue of vendor set-up work (register an OAuth app, get an API key, make a test account): one sealed record
 * per task, so a long run of many vendors survives a restart, shows what is waiting on a person, and says why.
 * It replaces a hand-edited list: every change is a status and a note, never a rewrite of a file. */
import { createHash } from 'node:crypto';
import { readVaultRecords, writeVaultRecord } from './credential-vault.js';

export const TASK_STATUSES = ['queued', 'working', 'done', 'needs-human', 'blocked', 'no-self-serve'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
/** Why a person is needed, so the waiting list can be worked through by kind (all the captchas at once). */
export const TASK_REASONS = ['captcha', 'sms', 'email', 'payment', 'identity', 'review', 'two-factor', 'other'] as const;
export type TaskReason = typeof TASK_REASONS[number];
export const TASK_KINDS = ['oauth-app', 'api-key', 'test-account', 'webhook', 'connector-proof', 'other'] as const;
export type TaskKind = typeof TASK_KINDS[number];

export type Task = {
  vendor: string; kind: TaskKind; status: TaskStatus; reason?: TaskReason; note?: string;
  /** The account the vendor's app or key is registered under. */
  owner?: string;
  /** Connector ids this task covers. */
  connectors?: string[];
  updatedAt: string;
};
export type SavedTask = Task & { id: string };

const FOLDER = 'task';
const MAX_NOTE = 500;

/** One task per vendor and kind: the same pair always lands on the same record, so a second report updates it. */
export function taskId(vendor: string, kind: string): string {
  const hex = createHash('sha256').update(`${vendor.trim().toLowerCase()}|${kind}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function listTasks(stateDir: string, filter: { status?: TaskStatus; reason?: TaskReason } = {}): Promise<SavedTask[]> {
  return (await readVaultRecords<Task>(stateDir, FOLDER))
    .map(({ id, value }) => ({ ...value, id }))
    .filter(task => (!filter.status || task.status === filter.status) && (!filter.reason || task.reason === filter.reason))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.kind.localeCompare(b.kind));
}

/** Creates the task or updates the one for this vendor and kind; what is not given stays as it was. */
export async function saveTask(stateDir: string, input: { vendor: string; kind?: TaskKind; status?: TaskStatus; reason?: TaskReason; note?: string; owner?: string; connectors?: string[] }): Promise<SavedTask> {
  const vendor = input.vendor.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 ._-]{0,59}$/.test(vendor)) throw new Error(`A vendor is a short name of letters and digits (got "${input.vendor}").`);
  const kind = input.kind ?? 'oauth-app';
  if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown task kind "${kind}". Kinds: ${TASK_KINDS.join(', ')}.`);
  if (input.status && !(TASK_STATUSES as readonly string[]).includes(input.status)) throw new Error(`Unknown status "${input.status}". Statuses: ${TASK_STATUSES.join(', ')}.`);
  if (input.reason && !(TASK_REASONS as readonly string[]).includes(input.reason)) throw new Error(`Unknown reason "${input.reason}". Reasons: ${TASK_REASONS.join(', ')}.`);
  const id = taskId(vendor, kind);
  const before = (await listTasks(stateDir)).find(task => task.id === id);
  const status = input.status ?? before?.status ?? 'queued';
  // A reason belongs to the status it was given for: a task that moves on to done or working has no one waiting.
  const reason = input.reason ?? (input.status && input.status !== before?.status && !['needs-human', 'blocked'].includes(status) ? undefined : before?.reason);
  const connectors = input.connectors ? [...new Set([...(before?.connectors ?? []), ...input.connectors])].sort() : before?.connectors;
  const note = input.note !== undefined ? input.note.trim().slice(0, MAX_NOTE) : before?.note;
  const owner = input.owner?.trim() || before?.owner;
  const saved: Task = { vendor, kind, status, ...(reason ? { reason } : {}), ...(note ? { note } : {}), ...(owner ? { owner } : {}), ...(connectors?.length ? { connectors } : {}), updatedAt: new Date().toISOString() };
  await writeVaultRecord(stateDir, FOLDER, id, saved);
  return { ...saved, id };
}

export function describeTask(task: Task): string {
  return `${task.vendor} (${task.kind}): ${task.status}${task.reason ? ` [${task.reason}]` : ''}${task.owner ? `, owner ${task.owner}` : ''}${task.note ? ` — ${task.note}` : ''}`;
}

/** Counts by status and, for what waits on a person, by reason. */
export function summarizeTasks(tasks: readonly Task[]): string {
  const by = new Map<string, number>();
  for (const task of tasks) by.set(task.status, (by.get(task.status) ?? 0) + 1);
  const waiting = new Map<string, number>();
  for (const task of tasks) if (task.status === 'needs-human') waiting.set(task.reason ?? 'other', (waiting.get(task.reason ?? 'other') ?? 0) + 1);
  return `${tasks.length} tasks: ${TASK_STATUSES.filter(s => by.get(s)).map(s => `${by.get(s)} ${s}`).join(', ') || 'none'}${waiting.size ? `. Waiting on you: ${[...waiting].map(([r, n]) => `${n} ${r}`).join(', ')}` : ''}.`;
}
