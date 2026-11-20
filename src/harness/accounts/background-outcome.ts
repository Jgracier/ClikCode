/** What a background vendor run came to is remembered, so a vendor that
 * cannot answer is not started again at every window open.
 *
 * - A refusal for want of a sign-in marks the account as needing one (as a
 *   usage probe's signed-out answer does): every background caller reads
 *   `status === 'ready'` first, so nothing starts that vendor for that
 *   account again until the user signs in -- which sets it ready.
 * - A failure (timeout, crash, no answer) is held off with backoff, per
 *   question, across every ClikCode process: 5 minutes, doubling, at most 6
 *   hours. An answer clears it. */

import { quiet } from '../../runtime/lifecycle-log.js';
import { jsonMemo } from '../../session/store/json-memo.js';
import type { AiHarnessAccount } from '../definition.js';
import type { VendorOutcome } from './vendor-probe.js';

const FIRST_HOLD_MS = 5 * 60_000;
const LONGEST_HOLD_MS = 6 * 3_600_000;

interface HeldOff { at: number; failures: number }
interface BackoffFile { v: 1; held: Record<string, HeldOff> }

const memo = jsonMemo<BackoffFile>('cache/background-backoff.json', () => ({ v: 1, held: {} }), (parsed) => {
  const file = parsed as BackoffFile;
  return file.v === 1 && file.held && typeof file.held === 'object' ? file : undefined;
});

/** How long the `failures`-th failure in a row holds a question off. */
export function backoffMs(failures: number): number {
  return Math.min(LONGEST_HOLD_MS, FIRST_HOLD_MS * 2 ** Math.max(0, failures - 1));
}

/** Whether `key` failed recently enough that it must not be asked yet. */
export async function heldOff(key: string, now = Date.now()): Promise<boolean> {
  const entry = (await memo.load()).held[key];
  return Boolean(entry && now - entry.at < backoffMs(entry.failures));
}

/** Records an answer (clears the hold) or a failure (lengthens it). A
 * signed-out refusal is not a failure here: it started nothing, and the
 * account it belongs to is marked instead (markAccountNeedsSignIn). */
export async function recordBackgroundOutcome(key: string, outcome: VendorOutcome<unknown>['status'], now = Date.now()): Promise<void> {
  const file = await memo.load();
  if (outcome === 'ok') {
    if (!(key in file.held)) return;
    delete file.held[key];
  } else if (outcome === 'failed') {
    file.held[key] = { at: now, failures: (file.held[key]?.failures ?? 0) + 1 };
  } else {
    return;
  }
  memo.changed();
  await memo.save().catch(quiet('harness/accounts/background-outcome'));
}

/** A background run was refused for this account: no credential on disk.
 * It needs a sign-in, said on the record, so nothing asks it again. */
export async function markAccountNeedsSignIn(account: Pick<AiHarnessAccount, 'id'> | undefined): Promise<void> {
  if (!account?.id) return;
  // The caller's copy too, so the same pass does not ask it again.
  if ('status' in account && (account as AiHarnessAccount).status === 'ready') (account as AiHarnessAccount).status = 'needs_login';
  try {
    // Loaded when needed: the state modules import the harness catalog, which
    // imports this module's callers.
    const { readState } = await import('../../session/state/read.js');
    const { writeState } = await import('../../session/state/write.js');
    const state = await readState({ transcripts: [] });
    const held = state.accounts.find((item) => item.id === account.id);
    if (!held || held.status !== 'ready') return;
    held.status = 'needs_login';
    await writeState(state);
  } catch (error) { quiet('harness/accounts/background-outcome')(error); }
}

/** Forget every hold, on disk too (tests). */
export async function clearBackgroundBackoff(): Promise<void> { await memo.write({ v: 1, held: {} }); }
