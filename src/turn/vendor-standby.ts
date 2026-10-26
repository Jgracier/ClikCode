/** Opening the failover account's standby beside an attempt on an account near its limit. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { quotaRefusalHolds, vendorWindows } from '../harness/accounts/usage-reading.js';
import type { HarnessState } from '../session/model.js';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { nextUsableFailoverAccount, turnBackendForAccount } from './account-routing.js';
import { turnEnvironment } from './turn-environment.js';
import { prepareAcpStandby, prepareCodexStandby } from './vendor-session-attempt.js';
import type { VendorTransport } from './vendor-observer.js';
import { turnEffort, type VendorTurnContext } from './vendor-turn-context.js';
import { turnPermissionMode } from './turn-permission.js';

/** How much of a window an account has used before a turn on it opens a
 * standby for the account a failover would move to: a second vendor child
 * (for Claude, a whole agent with its own MCP servers) is worth starting only
 * when a refusal is likely. 80% opened one on most turns of an account with a
 * weekly window in the 80s and days left in it (2026-10-21), nowhere near a
 * refusal. */
export const STANDBY_AT_USED_PCT = 90;

/** Whether a turn on this account is close enough to a refusal to open a
 * standby: a window that can stop it, still current (a figure from a window
 * that has since reset describes last period), at STANDBY_AT_USED_PCT or
 * more; or a refusal from the vendor that nothing since overrules. */
export function nearUsageLimit(account: AiHarnessAccount, now: number = Date.now()): boolean {
  return quotaRefusalHolds(account, now) || vendorWindows(account).some((window) => !window.advisory
    && window.usedPct >= STANDBY_AT_USED_PCT
    && (window.resetsAt === undefined || Date.parse(window.resetsAt) > now));
}

/** The account a standby would be opened for beside a turn on `account`, or
 * none: only when `account` is near its limit, and only when there is another
 * account a failover could move to. Never because a turn started or a chat
 * was opened or moved. */
export function standbyAccountFor(
  state: HarnessState, account: AiHarnessAccount, now: number = Date.now(),
): AiHarnessAccount | undefined {
  if (!nearUsageLimit(account, now)) return undefined;
  return nextUsableFailoverAccount(state, account, (item) => turnBackendForAccount(item) === 'vendor', new Map(), now);
}

/** Warm only the next account's process. Its thread is carried on an actual
 * failover, after the old attempt flushes: speculative copying cannot delay
 * the primary request or race with a vendor writing that conversation. */
export function openFailoverStandby(ctx: VendorTurnContext, transport: VendorTransport): void {
  const { state, session, harness, account, model, run, attempt } = ctx;
  const persistentStandby = (transport === 'acp' || transport === 'codex-app-server') && Boolean(run.persistentTransports);
  if (!persistentStandby || attempt.standbyOpened) return;
  attempt.standbyOpened = true;
  const standbyFor = standbyAccountFor(state, account);
  if (!standbyFor) return;
  const permission = turnPermissionMode(harness, session.permissionMode);
  void (async () => {
    lifecycle('worker.standby', { harness: harness.command, account: standbyFor.id.slice(0, 8), process: persistentStandby });
    const standbyEnvironment = turnEnvironment(harness, standbyFor, permission);
    if (transport === 'codex-app-server') {
      await prepareCodexStandby({ harness, account: standbyFor, session, model, effort: turnEffort(ctx), environment: standbyEnvironment });
      return;
    }
    await prepareAcpStandby({
      harness, account: standbyFor, session, model, effort: turnEffort(ctx), environment: standbyEnvironment,
    });
  })().catch(quiet('turn/vendor-standby'));
}
