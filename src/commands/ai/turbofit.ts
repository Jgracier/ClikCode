/** TurboFit local models, as the commands see them: bring the runtime up
 * when a session moves onto a TurboFit model, let go of it when the session
 * moves off or closes, and make sure it is up before a turn. The work is in
 * harness/accounts/turbofit-local.ts; this is where it meets the screen. */

import { hermesTurboFitModelId } from '../../harness/accounts/hermes-discovery.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import { emitHarnessOutput } from '../../harness/output.js';
import {
  ensureTurboFitServing, isTurboFitModel, prepareTurboFitModel, releaseTurboFitLeasesOnExit, releaseTurboFitRuntime,
} from '../../harness/accounts/turbofit-local.js';
import { waitingLineProgress, type ProgressSink } from './local-model.js';

let exitHookInstalled = false;

/** Long work with its progress on the waiting line (see waitingLineProgress);
 * a runtime already up, the usual case before a turn, shows nothing. */
async function withProgress<T>(work: (progress: (message: string) => void) => Promise<T>, sink?: ProgressSink): Promise<T> {
  if (!exitHookInstalled) { exitHookInstalled = true; releaseTurboFitLeasesOnExit(); }
  const shown = waitingLineProgress(sink);
  try { return await work((message) => shown.show(message, message.replace(/\d+/g, '#'))); }
  finally { shown.done(); }
}

function reportNotice(notice: string | undefined): void {
  if (notice) emitHarnessOutput({ panel: 'notice', message: notice });
}

/** A Hermes session's model changed from `previous` to `next`. */
export async function turboFitModelChanged(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string,
  previous: string | null | undefined, next: string | null | undefined, profile?: string,
): Promise<void> {
  if (!harness.turboFit) return;
  if (isTurboFitModel(next)) {
    const ready = await withProgress((progress) => (profile
      ? prepareTurboFitModel(harness, account, sessionId, next!, progress, profile)
      : ensureTurboFitServing(harness, account, sessionId, next!, progress)));
    reportNotice(ready.notice);
  } else if (isTurboFitModel(previous)) {
    await releaseTurboFitRuntime(account, sessionId);
  }
}

/** Before a turn: a session on a TurboFit model has its runtime running.
 * Returns the model as Hermes can route it -- a session saved with the old
 * `turbofit:` spelling is corrected here, on its next turn. */
export async function ensureTurboFitForTurn<T extends string | null | undefined>(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, sessionId: string, model: T, sink?: ProgressSink,
): Promise<T> {
  if (!harness.turboFit || !isTurboFitModel(model)) return model;
  const routable = hermesTurboFitModelId(model!) as T;
  const ready = await withProgress((progress) => ensureTurboFitServing(harness, account, sessionId, routable!, progress), sink);
  reportNotice(ready.notice);
  return routable;
}

/** A session closed: it no longer holds the runtime. */
export async function turboFitSessionClosed(account: AiHarnessAccount | undefined, sessionId: string): Promise<void> {
  await releaseTurboFitRuntime(account, sessionId);
}
