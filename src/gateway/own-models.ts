/**
 * The user's own models on ClikDeploy compute, as the Gateway serves them: start one now (so a model just chosen
 * is starting while the user types, not from their first message), and how long one may sit idle before its GPU
 * is released (the account's setting: 5 minutes unless changed, 0 = never; the same one the canvas's Preferences
 * change).
 */
import { quiet } from '../runtime/lifecycle-log.js';
import Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

type Options = { config?: Conf; fetchImpl?: typeof fetch; timeoutMs?: number };

const ALWAYS_START_OWN_MODELS = 'gateway.alwaysStartOwnModels';

/** Whether choosing an asleep private model should start it without asking again. */
export function alwaysStartOwnModels(config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 })): boolean {
  return config.get(ALWAYS_START_OWN_MODELS) === true;
}

/** Remember the user's explicit "Always start hosted AI models" choice locally. */
export function setAlwaysStartOwnModels(
  enabled: boolean,
  config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 }),
): void {
  config.set(ALWAYS_START_OWN_MODELS, enabled);
}

async function gatewayCall(path: string, init: { method: string; body?: unknown }, options: Options = {}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | undefined }> {
  const config = options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const { baseUrl, apiKey } = gatewayConnection(config);
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const body = await response.json().catch(quiet('gateway/own-models')) as Record<string, unknown> | undefined;
  return { ok: response.ok, status: response.status, body };
}

function gatewayError(what: string, result: { status: number; body: Record<string, unknown> | undefined }): Error {
  const error = result.body?.error as { message?: unknown } | undefined;
  return new Error(`ClikDeploy Gateway ${what}: ${typeof error?.message === 'string' ? error.message : `HTTP ${result.status}`}`);
}

/** Where a starting model is: looking for a machine, or loading onto the one it got (with what is left of the usual start). */
export type OwnModelStart =
  | { phase: 'finding-server' }
  | { phase: 'starting-model'; elapsedS: number; expectedS?: number; remainingS?: number; overdue?: boolean };

function startOf(raw: unknown): OwnModelStart | undefined {
  const value = raw as { phase?: unknown; elapsedS?: unknown; expectedS?: unknown; remainingS?: unknown; overdue?: unknown } | undefined;
  if (value?.phase === 'finding-server') return { phase: 'finding-server' };
  if (value?.phase !== 'starting-model' || typeof value.elapsedS !== 'number') return undefined;
  const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return {
    phase: 'starting-model', elapsedS: value.elapsedS,
    ...(number(value.expectedS) ? { expectedS: value.expectedS } : {}),
    ...(number(value.remainingS) ? { remainingS: value.remainingS } : {}),
    ...(value.overdue === true ? { overdue: true } : {}),
  };
}

/** Start one of the user's own models now (a no-op when it is running or already on its way), and how its start is going. */
export async function ownModelStatus(model: string, options: Options = {}): Promise<{ state: 'running' | 'starting'; start?: OwnModelStart }> {
  const result = await gatewayCall('/v1/models/wake', { method: 'POST', body: { model } }, options);
  const data = result.body?.data as { state?: unknown; start?: unknown } | undefined;
  if (!result.ok || (data?.state !== 'running' && data?.state !== 'starting')) throw gatewayError('wake', result);
  const start = data.state === 'starting' ? startOf(data.start) : undefined;
  return { state: data.state, ...(start ? { start } : {}) };
}

/** Start one of the user's own models now. 'running' when it already serves; 'starting' when it is on its way. */
export async function wakeOwnModel(model: string, options: Options = {}): Promise<'running' | 'starting'> {
  return (await ownModelStatus(model, options)).state;
}

/** How long the user's models may sit idle before their GPU is released, in minutes; 0 = never. */
export async function ownModelIdleMinutes(options: Options = {}): Promise<number> {
  const result = await gatewayCall('/v1/settings', { method: 'GET' }, options);
  const minutes = (result.body?.data as { model_idle_minutes?: unknown } | undefined)?.model_idle_minutes;
  if (!result.ok || typeof minutes !== 'number') throw gatewayError('settings', result);
  return minutes;
}

/** Change it (0 = never, else 5 minutes to a day): it applies to every one of the user's models. */
export async function setOwnModelIdleMinutes(minutes: number, options: Options = {}): Promise<number> {
  const result = await gatewayCall('/v1/settings', { method: 'PATCH', body: { model_idle_minutes: minutes } }, options);
  const stored = (result.body?.data as { model_idle_minutes?: unknown } | undefined)?.model_idle_minutes;
  if (!result.ok || typeof stored !== 'number') throw gatewayError('settings', result);
  return stored;
}

/** The idle times offered (minutes; 0 = never), as the canvas offers them. */
export const OWN_MODEL_IDLE_CHOICES = [5, 15, 30, 60, 240, 0] as const;

/** `5 min`, `1 hr`, `never`. */
export function idleWords(minutes: number): string {
  if (!minutes) return 'never';
  return minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}
