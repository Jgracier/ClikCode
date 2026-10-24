/** What the agent loop does about a model step that failed: classify it, wait or retry. */
import { turnCancelledError } from './cancellation.js';
import type { HarnessErrorKind } from './model-client.js';
import type { OwnModelStart } from '../gateway/own-models.js';

/** A model step that failed before saying anything is retried for as long as this much waiting in
 * total, then the failure is the answer. Time, not a count: a short blip costs one quick retry, a
 * longer one gets the patience it needs, and an outage ends in minutes with the real error. */
export const STEP_RETRY_BUDGET_SECONDS = 300;
/** The longest single wait of the backoff (1, 2, 4, 8, 16, 30, 30 ...). */
const STEP_RETRY_CAP_SECONDS = 30;
/** The longest a server's own Retry-After is honoured for one wait. */
const RETRY_AFTER_CAP_SECONDS = 120;
/** A start that has taken this many times what the Gateway says it usually takes (its `expectedS`) is not
 * going to finish: the wait ends and the step's own answer is shown. The numbers are all the Gateway's
 * (its elapsed time, its expected time); a start it reports no expected time for (still finding a server)
 * has no clock here -- the Gateway ends that on its side, by answering something other than MODEL_STARTING --
 * and the user's Stop ends any wait. A client with no status at all (nothing reports the start) spends the
 * step retry budget instead. MEASURED 2026-10-22: a 0.5B vLLM model on ClikDeploy capacity took 11-16 min cold. */
export const START_OVERRUN_FACTOR = 2;

/** What the Gateway last said of a starting model, and when it was read. */
export interface StartReading { start: OwnModelStart; at: number }

/** Whether a model that is starting is still worth waiting `waitS` more for, by the Gateway's own
 * reading of the start (`waitedSeconds`: what this step already waited, for a client with no reading). */
export function startMayContinue(reading: StartReading | undefined, waitedSeconds: number, waitS: number, now = Date.now()): boolean {
  if (!reading) return waitedSeconds + waitS <= STEP_RETRY_BUDGET_SECONDS;
  const { start } = reading;
  if (start.phase !== 'starting-model' || start.expectedS === undefined) return true;
  return start.elapsedS + (now - reading.at) / 1000 <= START_OVERRUN_FACTOR * start.expectedS;
}
/** How often a model that is starting is asked again: when the Gateway says (its Retry-After follows what is left of
 * the GPU's usual start, 5-30 s), at least every 5 s and at most every minute. */
export function modelStartWaitSeconds(retryAfter?: number): number {
  return Math.min(60, Math.max(5, retryAfter !== undefined && Number.isFinite(retryAfter) ? retryAfter : 30));
}
/** Empty or repeated continuations allowed after an output cutoff. Productive
 * continuations have no fixed chunk count. */
export const MAX_LENGTH_CONTINUES = 3;
export const CONTINUE_AFTER_LENGTH = '[harness] Your last reply reached the output limit and was cut off. Continue exactly where it stopped, without repeating anything already written.';

/** Structured classification only: a status code or an explicit kind set by
 * the model client. Message text is never pattern-matched here. */
export function classifyModelError(error: unknown): { kind: HarnessErrorKind; retryAfter?: number } {
  const record = (error ?? {}) as { kind?: unknown; errorKind?: unknown; statusCode?: unknown; status?: unknown; response?: { status?: unknown }; retryAfter?: unknown };
  const retryAfter = typeof record.retryAfter === 'number' && Number.isFinite(record.retryAfter) ? record.retryAfter : undefined;
  const explicit = record.errorKind ?? record.kind;
  if (explicit === 'quota' || explicit === 'auth') return { kind: explicit, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  const status = Number(record.statusCode ?? record.status ?? record.response?.status);
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status === 402 || status === 429) return { kind: 'quota', ...(retryAfter !== undefined ? { retryAfter } : {}) };
  return { kind: 'other', ...(retryAfter !== undefined ? { retryAfter } : {}) };
}

/** Codes the Gateway sends for a step that is worth sending again as it is:
 * its own words for these are "Please retry" (turn-stream.ts). */
const RETRYABLE_STEP_CODES = new Set(['MODEL_ERROR', 'INTERNAL_ERROR', 'MODEL_RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'incomplete_stream']);

/** How many times Stop hooks may send the agent back to work in one turn. */
export const MAX_STOP_HOOK_CONTINUES = 3;

/** What to do about a model step that failed before streaming anything.
 * `retry`: a transient failure -- a retryable code, a 5xx, or no response at all. `model-starting`: the
 * user's own model is coming up on its GPU; the step waits for it (startMayContinue).
 * Everything else -- credit, sign-in, a rejected request, no model, the kill switch -- is the answer. */
export function stepRecovery(error: unknown): 'retry' | 'model-starting' | 'capacity' | 'context-pressure' | undefined {
  const record = (error ?? {}) as { code?: unknown; statusCode?: unknown; kind?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (code === 'MODEL_BUSY') return 'capacity';
  if (code === 'CONTEXT_TOO_LARGE') return 'context-pressure';
  if (code === 'MODEL_STARTING') return 'model-starting';
  if (code && RETRYABLE_STEP_CODES.has(code)) return 'retry';
  if (code) return undefined;
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  if (status === undefined) return record.kind === 'other' ? 'retry' : undefined;
  return status >= 500 && status !== 501 ? 'retry' : undefined;
}

/** How long to wait before retry number `attempt` (1-based) of a failed step: an exponential backoff
 * with jitter, so a fleet of clients does not come back in the same instant -- never shorter than
 * the server's own Retry-After when it gave one (a `Retry-After: 0` from a server that keeps
 * failing must not become a hot loop). */
export function retryDelaySeconds(attempt: number, retryAfter?: number, random: () => number = Math.random): number {
  const backoff = Math.min(STEP_RETRY_CAP_SECONDS, 2 ** Math.max(0, attempt - 1)) * (0.8 + 0.4 * random());
  const hinted = retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(RETRY_AFTER_CAP_SECONDS, retryAfter) : 0;
  return Math.max(backoff, hinted);
}

/** Waits, unless the turn is cancelled first. */
export function pause(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(turnCancelledError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, seconds * 1000);
    const onAbort = (): void => { clearTimeout(timer); reject(turnCancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
