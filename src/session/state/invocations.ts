/** What each harness call cost.
 *
 * Every call is one line of `invocations.jsonl`, beside the index rather than
 * in it: the log is the biggest thing ClikCode keeps about usage, and it
 * changes once per turn, while the index (the conversation list) is rewritten
 * for every rename and setting. A new call is appended; the file is rewritten
 * only when an older record changed or when old records are folded away.
 *
 * Records are kept for RAW_RETENTION_DAYS -- what usage learning needs to see
 * a weekly window whole -- and older ones fold into per-day, per-account,
 * per-model totals on the index, so totals stay exact forever. */

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessState } from '../model.js';
import type { StateIndex } from './index-file.js';
import { sameData } from '../store/data.js';
import { cachedFile } from '../store/cached-file.js';
import { atomicWriteFile, ensurePrivateDirectory } from '../store/files.js';
import { stateDirectory } from '../store/paths.js';

const DAY_MS = 24 * 60 * 60_000;
/** Individual records are kept this long. */
export const RAW_RETENTION_DAYS = 30;
/** Folding waits until the oldest record is this much past retention, so the
 * log is rewritten every couple of days rather than on every turn. */
const FOLD_SLACK_DAYS = 2;
/** However busy, the log never holds more than this many records. */
const RAW_HARD_CAP = 50_000;

export type Invocation = HarnessState['invocations'][number];

export interface InvocationRollup {
  day: string; accountId: string; provider: string; model?: string;
  calls: number; inputTokens: number; outputTokens: number; latencyMs: number;
}

function rollupKey(invocation: Invocation): string {
  // An absent model groups with other absent ones rather than being folded
  // into some real model's totals.
  return [String(invocation.at).slice(0, 10), invocation.accountId, invocation.provider, invocation.model ?? ''].join('|');
}

/** Folds records older than RAW_RETENTION_DAYS (and any beyond RAW_HARD_CAP)
 * into per-day totals, so usage totals stay exact while the log stops growing
 * with every request ever made. */
export function capInvocations(index: StateIndex, now: number = Date.now()): void {
  const cutoff = new Date(now - RAW_RETENTION_DAYS * DAY_MS).toISOString();
  const foldBefore = new Date(now - (RAW_RETENTION_DAYS + FOLD_SLACK_DAYS) * DAY_MS).toISOString();
  const tooOld = index.invocations.some((invocation) => String(invocation.at) < foldBefore);
  if (!tooOld && index.invocations.length <= RAW_HARD_CAP) return;
  const ordered = index.invocations
    .map((invocation, position) => ({ invocation, position }))
    .sort((left, right) => String(left.invocation.at).localeCompare(String(right.invocation.at)) || left.position - right.position);
  const overflow = ordered.filter((entry, rank) => String(entry.invocation.at) < cutoff || rank < ordered.length - RAW_HARD_CAP);
  const rolled = new Set(overflow.map((entry) => entry.invocation));
  const rollups = { ...index.invocationRollups };
  for (const { invocation } of overflow) {
    const key = rollupKey(invocation);
    const previous = rollups[key] ?? {
      day: String(invocation.at).slice(0, 10), accountId: invocation.accountId, provider: invocation.provider, model: invocation.model,
      calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0,
    };
    rollups[key] = {
      ...previous,
      calls: previous.calls + 1,
      inputTokens: previous.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: previous.latencyMs + (invocation.latencyMs ?? 0),
    };
    if (!index.rolledThrough || String(invocation.at) > index.rolledThrough) index.rolledThrough = String(invocation.at);
  }
  index.invocationRollups = rollups;
  index.invocations = index.invocations.filter((invocation) => !rolled.has(invocation));
}

// ---------------------------------------------------------------------------
// The log file
// ---------------------------------------------------------------------------

export function invocationLogPath(): string {
  return join(stateDirectory(), 'invocations.jsonl');
}

export interface InvocationLog {
  invocations: Invocation[];
  /** Every line parsed and the file ends in a newline: safe to append to. A
   *  crash mid-append leaves a torn last line, which is skipped on read and
   *  dropped by the next (full) write. */
  appendable: boolean;
}

function parseLog(raw: string): InvocationLog {
  const byId = new Map<string, Invocation>();
  let appendable = raw === '' || raw.endsWith('\n');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Invocation;
      if (record && typeof record.id === 'string') { byId.delete(record.id); byId.set(record.id, record); continue; }
    } catch { /* fail-open-ok: a torn line from a crash mid-append */ }
    appendable = false;
  }
  return { invocations: [...byId.values()], appendable };
}

const logFile = cachedFile(invocationLogPath, parseLog);

export async function loadInvocationLog(): Promise<InvocationLog> {
  return (await logFile.load()) ?? { invocations: [], appendable: true };
}

export function resetInvocationLogCache(): void {
  logFile.reset();
}

const lines = (records: readonly Invocation[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join('');

/** Makes the log hold exactly `next`, under the caller's state lock: an
 * append when `next` only adds to what is stored, otherwise a rewrite. */
export async function storeInvocationLog(next: readonly Invocation[]): Promise<void> {
  const disk = await loadInvocationLog();
  const stored = disk.invocations;
  const appendOnly = disk.appendable && stored.length <= next.length
    && stored.every((record, position) => record === next[position] || sameData(record, next[position]));
  if (appendOnly) {
    const added = next.slice(stored.length);
    if (!added.length) return;
    await ensurePrivateDirectory(stateDirectory());
    const handle = await open(invocationLogPath(), 'a', 0o600);
    try {
      await handle.writeFile(lines(added), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    if (!next.length && !stored.length && disk.appendable) return;
    await atomicWriteFile(invocationLogPath(), lines(next));
  }
  // Re-read on the next load: cheap, and exact even if the append raced a reader.
  logFile.reset();
}

export const STATE_ROLLUPS = Symbol('clikcode.invocationRollups');

/** Per-day totals of invocations folded out of the log. */
export function invocationRollups(state: HarnessState): InvocationRollup[] {
  return Object.values((state as HarnessState & { [STATE_ROLLUPS]?: Record<string, InvocationRollup> })[STATE_ROLLUPS] ?? {});
}
