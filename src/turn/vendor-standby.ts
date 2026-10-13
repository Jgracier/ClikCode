/** Opening the failover account's standby beside an attempt on an account near its limit. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { vendorWindows } from '../harness/accounts/usage-reading.js';
import { carryNativeSession } from '../session/carry.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { nextUsableFailoverAccount, turnBackendForAccount } from './account-routing.js';
import { turnEnvironment } from './turn-environment.js';
import { prepareAcpStandby, prepareCodexStandby } from './vendor-session-attempt.js';
import type { VendorTransport } from './vendor-observer.js';
import { turnEffort, type VendorTurnContext } from './vendor-turn-context.js';

/** How much of a window an account has used before a turn on it opens a
 * standby for the account a failover would move to (worth a second vendor
 * child only when a refusal is likely). */
const STANDBY_AT_USED_PCT = 80;
function nearUsageLimit(account: AiHarnessAccount): boolean {
  return vendorWindows(account).some((window) => !window.advisory && window.usedPct >= STANDBY_AT_USED_PCT);
}

/** An account close to its limit may refuse this turn. The account a
 * failover would move to is opened beside it, on a standby child: the
 * thread copied as it stands now (before this attempt adds to it), its
 * agent started and the thread loaded while this attempt runs. A refusal
 * then hands over without a cold start, which for Claude is seconds of
 * starting a session and connecting every MCP server.
 * A harness run as one process per turn (structured or text CLI) has no
 * child to open ahead; what a switch would still do -- copy the thread
 * to the next account -- is done now instead, so a
 * refusal hands over with nothing left but the next process's start. */
export async function openFailoverStandby(ctx: VendorTurnContext, transport: VendorTransport): Promise<void> {
  const { state, session, harness, account, model, run, attempt } = ctx;
  const persistentStandby = (transport === 'acp' || transport === 'codex-app-server') && Boolean(run.persistentTransports);
  if (!((persistentStandby || transport === 'structured-cli' || transport === 'text-cli') && !attempt.standbyOpened && nearUsageLimit(account))) return;
  attempt.standbyOpened = true;
  const next = nextUsableFailoverAccount(state, account, (item) => turnBackendForAccount(item) === 'vendor', new Map());
  const threadReady = !next ? false : !session.nativeSessionId || session.nativeSessionPreallocated ? true
    : Boolean(await carryNativeSession({
      harness, nativeId: session.nativeSessionId, workspace: session.workspace,
      from: turnEnvironment(harness, account), to: turnEnvironment(harness, next),
    }).catch(() => undefined));
  if (!next || !threadReady) return;
  const standbyFor = next;
  attempt.threadCopiedTo = next.id;
  const permission = session.permissionMode ?? 'ask';
  void (async () => {
    lifecycle('worker.standby', { harness: harness.command, account: standbyFor.id.slice(0, 8), process: persistentStandby });
    if (!persistentStandby) return;
    const standbyEnvironment = turnEnvironment(harness, standbyFor, permission);
    if (transport === 'codex-app-server') {
      await prepareCodexStandby({ harness, account: standbyFor, session, model, effort: turnEffort(ctx), environment: standbyEnvironment });
      return;
    }
    await prepareAcpStandby({
      harness, account: standbyFor, session, model, effort: turnEffort(ctx), environment: standbyEnvironment,
    });
  })().catch(() => undefined);
}
