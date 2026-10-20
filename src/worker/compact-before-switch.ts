/** Compacting a large conversation while its account is nearly out, so the switch costs little.
 *
 * When an account runs out the conversation moves to another, and the provider's prompt cache is
 * per account: the first turn there reads the whole history from scratch -- 28 s for a 750k-token
 * conversation (measured 2026-10-18), and the same tokens off the new account's usage. Pre-warming
 * that cache does not work through Claude Code (memory clikcode-cache-prewarm). Making the history
 * small does: after a turn that leaves the account at COMPACT_AT_USED_PCT or more, a conversation
 * over COMPACT_ABOVE_TOKENS is compacted on the account it is on, while that account's cache is
 * still warm, by the harness's own compaction (/compact, or Codex's thread compaction). Then the
 * switch reads a summary, and every turn after it is cheaper too.
 *
 * Only when a switch can happen (another account would take over), at most once per
 * RETRY_AFTER_MS per conversation (a compaction that failed is not retried every turn), and never
 * ahead of a message the user already queued. */
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { vendorWindows } from '../harness/accounts/usage-reading.js';
import { nextUsableFailoverAccount, turnBackendForAccount } from '../turn/account-routing.js';
import { canCompact } from '../tui/slash/compact.js';

/** 10% left, not 5%: a compaction is itself a long call on the account that is nearly out, and with 5% room a
 * big conversation ran the account dry before the summary was written. */
const COMPACT_AT_USED_PCT = 90;
export const COMPACT_ABOVE_TOKENS = 150_000;
const RETRY_AFTER_MS = 30 * 60_000;
const lastCompacted = new Map<string, number>();

export function shouldCompactBeforeSwitch(
  state: HarnessState, session: HarnessSession, account: AiHarnessAccount | undefined, now: number = Date.now(),
): boolean {
  if (!account || !canCompact(session.id, session)) return false;
  if ((session.lastUsage?.contextUsed ?? 0) < COMPACT_ABOVE_TOKENS) return false;
  if (session.queuedTurns?.some((entry) => entry.kind !== 'notification')) return false;
  if (!vendorWindows(account).some((window) => !window.advisory && window.usedPct >= COMPACT_AT_USED_PCT)) return false;
  if (now - (lastCompacted.get(session.id) ?? Number.NEGATIVE_INFINITY) < RETRY_AFTER_MS) return false;
  return Boolean(nextUsableFailoverAccount(state, account, (item) => turnBackendForAccount(item) === 'vendor', new Map()));
}

export function noteCompacted(sessionId: string, now: number = Date.now()): void {
  lastCompacted.set(sessionId, now);
}
