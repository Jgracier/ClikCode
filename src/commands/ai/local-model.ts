/** ClikCode Local models, as the commands see them: bring the session's
 * model up before a turn (from the terminal, so the model follows it), load
 * a newly chosen one before the session moves to it, and let go when the
 * session leaves the route or closes. The engine is src/local-models; this
 * is where it meets the screen, as commands/ai/turbofit.ts is for TurboFit.
 *
 * Leases are per process and session. The interactive terminal takes one
 * before handing a turn to its worker, and the worker joins without its
 * own; so the model stops when the terminal closes (or after the engine's
 * idle period), not whenever the long-lived worker happens to exit. A
 * headless send holds one for as long as it runs. */

import {
  ensureLocalModel, releaseLocalModel, releaseLocalModelsOnExit, type LocalModelEndpoint, type LocalModelProgress,
} from '../../local-models/index.js';
import type { LocalModelHooks } from '../../agent/models/for-session.js';
import { emitHarnessOutput } from '../../harness/output.js';
import type { HarnessSession } from '../../session/model.js';
import { TERMINAL } from '../../tui/active-terminal.js';

/** Sessions this process has taken a lease for, so letting go costs
 * nothing for the (usual) session that never had one. */
const held = new Set<string>();
/** Notices already shown, per session: the engine repeats its remark on
 * every cold start, and once is enough to know a model is slow here. */
const noticed = new Set<string>();

/** One progress update as a line: a download or runtime fetch with its
 * percentage, everything else as the engine words it. */
export function localProgressText(update: LocalModelProgress): string {
  if ((update.stage === 'download' || update.stage === 'runtime') && update.totalBytes) {
    const percent = Math.min(100, Math.floor(((update.bytes ?? 0) / update.totalBytes) * 100));
    return `${update.stage === 'download' ? 'downloading' : 'fetching llama.cpp'} ${update.message} ${percent}%`;
  }
  return update.message;
}

/** Long work with its progress on the waiting line; without a terminal, one
 * stderr line per distinct `shape` (a stage, not each percent) rather than
 * one per update. The wait starts on the first update, so work that has
 * nothing to do -- a model already running -- shows nothing at all. Shared
 * with commands/ai/turbofit.ts. */
export function waitingLineProgress(): { show: (text: string, shape: string) => void; done: () => void } {
  const terminal = TERMINAL.active;
  let waiting = false;
  let stage = '';
  return {
    show: (text, shape) => {
      if (terminal) {
        if (!waiting) { waiting = true; terminal.startWaiting(text); }
        terminal.updateWaitingLabel(text);
        return;
      }
      if (shape !== stage) { stage = shape; process.stderr.write(`${text}\n`); }
    },
    done: () => { if (waiting) terminal?.stopWaiting(); },
  };
}

/** ClikCode Local's progress: one stderr line per stage and per tenth of a
 * download. */
export function localModelProgress(): { progress: (update: LocalModelProgress) => void; done: () => void } {
  const shown = waitingLineProgress();
  return {
    progress: (update) => {
      const tenth = update.totalBytes ? Math.floor(((update.bytes ?? 0) / update.totalBytes) * 10) : 0;
      shown.show(localProgressText(update), `${update.stage}:${update.message.replace(/\d+/g, '#')}:${tenth}`);
    },
    done: shown.done,
  };
}

function reportNotice(sessionId: string, notice: string | undefined): void {
  if (!notice || noticed.has(`${sessionId}\n${notice}`)) return;
  noticed.add(`${sessionId}\n${notice}`);
  emitHarnessOutput({ panel: 'notice', message: `ClikCode Local: ${notice}` });
}

async function ensureWithProgress(sessionId: string, modelId: string | undefined, allowDownload = false): Promise<LocalModelEndpoint> {
  releaseLocalModelsOnExit();
  const shown = localModelProgress();
  try {
    const endpoint = await ensureLocalModel({ ...(modelId ? { modelId } : {}), sessionId, progress: shown.progress, allowDownload });
    held.add(sessionId);
    reportNotice(sessionId, endpoint.notice);
    return endpoint;
  } finally { shown.done(); }
}

/** The turn path's hooks into the seam (agent/models/for-session.ts):
 * progress where this process shows it, and each notice once. */
export function localModelTurnHooks(sessionId: string): LocalModelHooks & { done: () => void } {
  const shown = localModelProgress();
  held.add(sessionId);
  return { progress: shown.progress, notice: (text) => reportNotice(sessionId, text), done: shown.done };
}

/** Before a turn is handed to the worker: a ClikCode Local session's model
 * is running and this terminal holds it. Anything else is left alone. */
export async function ensureLocalModelForTurn(session: HarnessSession | undefined): Promise<void> {
  if (session?.route !== 'clikcode-local') return;
  await ensureWithProgress(session.id, session.model ?? undefined);
}

/** `/model <id>` after download consent: the model is downloaded, loaded and
 * answering before the session moves to it, so a failure leaves the
 * session on the model it had. The engine drops the session's lease on the
 * previous model once the new one holds it. */
export async function localModelChosen(sessionId: string, modelId: string): Promise<void> {
  await ensureWithProgress(sessionId, modelId, true);
}

/** The session no longer runs a local model here: closed, moved to another
 * route, or no longer the conversation this terminal shows. */
export async function releaseHeldLocalModel(sessionId: string): Promise<void> {
  if (!held.delete(sessionId)) return;
  await releaseLocalModel(sessionId).catch(() => undefined);
}

/** The interactive loop's rule, applied on every pass: this terminal holds
 * a local model only for the conversation it is showing, and only while
 * that conversation is on ClikCode Local. This one check covers every way
 * a session can leave (/provider, /settings route, /accounts use, /resume,
 * /new), rather than a release call at each of them. */
export async function reconcileLocalModelLeases(showing: HarnessSession | undefined): Promise<void> {
  for (const sessionId of [...held]) {
    if (showing?.id === sessionId && showing.route === 'clikcode-local') continue;
    await releaseHeldLocalModel(sessionId);
  }
}

/** For tests: forget what this process holds without touching the engine. */
export function resetLocalModelHeldForTests(): void {
  held.clear();
  noticed.clear();
}
