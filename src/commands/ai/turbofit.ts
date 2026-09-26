/** TurboFit local models, as the commands see them: bring the runtime up
 * when a session moves onto a TurboFit model, let go of it when the session
 * moves off or closes, and make sure it is up before a turn. The work is in
 * harness/accounts/turbofit-local.ts; this is where it meets the screen. */

import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import { emitHarnessOutput } from '../../harness/output.js';
import {
  ensureTurboFitServing, isTurboFitModel, prepareTurboFitModel, releaseTurboFitLeasesOnExit, releaseTurboFitRuntime,
} from '../../harness/accounts/turbofit-local.js';
import { TERMINAL } from '../../tui/active-terminal.js';

let exitHookInstalled = false;

/** Long work with its progress on the waiting line; without a terminal,
 * one stderr line per stage rather than one per percent. */
async function withProgress<T>(first: string, work: (progress: (message: string) => void) => Promise<T>): Promise<T> {
  if (!exitHookInstalled) { exitHookInstalled = true; releaseTurboFitLeasesOnExit(); }
  // Started on the first progress report, so a runtime already up (the usual
  // case before a turn) shows nothing at all.
  const terminal = TERMINAL.active;
  let waiting = false;
  let stage = '';
  const progress = (message: string): void => {
    if (terminal) {
      if (!waiting) { waiting = true; terminal.startWaiting(first); }
      terminal.updateWaitingLabel(message);
      return;
    }
    const shape = message.replace(/\d+/g, '#');
    if (shape !== stage) { stage = shape; process.stderr.write(`${message}\n`); }
  };
  try { return await work(progress); }
  finally { if (waiting) terminal?.stopWaiting(); }
}

function reportNotice(notice: string | undefined): void {
  if (notice) emitHarnessOutput({ panel: 'notice', message: notice });
}

/** A Hermes session's model changed from `previous` to `next`. */
export async function turboFitModelChanged(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string,
  previous: string | null | undefined, next: string | null | undefined, profile?: string,
): Promise<void> {
  if (harness.command !== 'hermes') return;
  if (isTurboFitModel(next)) {
    const ready = await withProgress('starting TurboFit…', (progress) => (profile
      ? prepareTurboFitModel(harness, account, sessionId, next!, progress, profile)
      : ensureTurboFitServing(harness, account, sessionId, next!, progress)));
    reportNotice(ready.notice);
  } else if (isTurboFitModel(previous)) {
    await releaseTurboFitRuntime(account, sessionId);
  }
}

/** Before a turn: a session on a TurboFit model has its runtime running. */
export async function ensureTurboFitForTurn(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string, model: string | null | undefined,
): Promise<void> {
  if (harness.command !== 'hermes' || !isTurboFitModel(model)) return;
  const ready = await withProgress('starting TurboFit…', (progress) => ensureTurboFitServing(harness, account, sessionId, model!, progress));
  reportNotice(ready.notice);
}

/** A session closed: it no longer holds the runtime. */
export async function turboFitSessionClosed(account: AiHarnessAccount | undefined, sessionId: string): Promise<void> {
  await releaseTurboFitRuntime(account, sessionId);
}
