/** Which model client feeds ClikCode's own agent for a session.
 *
 * The agent loop (run-turn.ts) is the same whichever inference is behind it;
 * only this choice differs by route. Keeping it in one function means the
 * turn path never asks "which route?" to build a client, and ClikCode Local's
 * engine (src/local-models) plugs in here and nowhere else. */

import type Conf from 'conf';
import type { ModelClient } from '../model-client.js';
import { OpenAIModelClient } from './openai-client.js';
import { STREAM_IDLE_TIMEOUT_MS } from './gateway-client.js';
import { gatewayStepOptions } from '../../gateway/options.js';
import { ensureLocalModel, releaseLocalModelsOnExit, type LocalModelProgress } from '../../local-models/index.js';
import { prefixCacheFor } from '../../local-models/prefix-cache.js';
import { recordLocalTurnTiming } from '../../local-models/turn-timings.js';
import { CLIKCODE_LOCAL_LABEL } from '../../session/route.js';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { harnessCommand } from '../../session/state/paths.js';
import { CLIKCODE_VERSION } from '../../version.js';
import type { HarnessSession } from '../../session/model.js';

/** How the caller shows a local model coming up. The turn path passes the
 * waiting line (or stderr headless); nothing is shown when omitted. */
export interface LocalModelHooks {
  progress?: (update: LocalModelProgress) => void;
  /** The engine's one-off remark about the model (slow here, no tool
   * calls, a fallback pick). */
  notice?: (text: string) => void;
}

/** The Gateway's base URL and the credential for it, or the error that says
 * how to connect. Exported so everything else that talks to the same service
 * (its model list, its usage) resolves them identically. */
export function gatewayConnection(config: Conf): { baseUrl: string; apiKey: string } {
  const baseUrl = getApiUrl(config).replace(/\/$/, '');
  const apiKey = getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  return { baseUrl, apiKey };
}

/** The Gateway's own error codes (its OpenAI-compatible API) as the codes
 * the agent loop acts on (run-turn.ts stepRecovery) or the gateway route
 * checks (gateway/harness.ts). */
export const GATEWAY_ERROR_CODES: Readonly<Record<string, string>> = {
  rate_limit_exceeded: 'MODEL_RATE_LIMITED',
  upstream_error: 'MODEL_ERROR',
  internal_error: 'INTERNAL_ERROR',
  context_length_exceeded: 'CONTEXT_TOO_LARGE',
  model_not_found: 'MODEL_UNAVAILABLE',
  no_model_available: 'NO_MODEL_AVAILABLE',
  gateway_disabled: 'CLIKCODE_DISABLED',
  insufficient_credits: 'AI_CREDIT_EXHAUSTED',
};

/** What the Gateway refuses with a 400 (`invalid_request`): a request is
 * fitted to these, or compacted, before it is sent. */
export const GATEWAY_REQUEST_LIMITS = { messages: 2_000, tools: 128, schemaBytes: 16 * 1024, systemBytes: 64 * 1024 } as const;

/** A Gateway refusal with what to do about it added: the Gateway's own
 * message names the model or the limit, and the hint says where to go next. */
export function gatewayErrorMessage(error: { status?: number; code?: string; message: string; retryAfter?: number }): string | undefined {
  const command = harnessCommand();
  const wait = error.retryAfter === undefined ? 'Try again in a minute.'
    : `Try again in ${error.retryAfter < 90 ? `${Math.ceil(error.retryAfter)}s` : `${Math.ceil(error.retryAfter / 60)} min`}.`;
  const hint = {
    insufficient_credits: `Run \`${command} gateway credit\` to add credit.`,
    rate_limit_exceeded: wait,
    model_not_found: 'Pick another model with /model, or let the Gateway choose (Automatic).',
    no_model_available: 'No model can take this request right now: try again shortly, or pick one with /model.',
    gateway_disabled: 'ClikDeploy Gateway is turned off for this account; switch provider with /model meanwhile.',
  }[error.code ?? (error.status === 402 ? 'insufficient_credits' : error.status === 429 ? 'rate_limit_exceeded' : '')];
  return hint ? `${error.message} ${hint}` : undefined;
}

/** ClikDeploy Gateway's OpenAI-compatible API (`{baseUrl}/v1`), the same one
 * any OpenAI client uses. `model` is a name from its list; none sends `auto`
 * and the Gateway picks. The session id keeps a conversation on one
 * provider, so its prompt stays cached. `options` are the session's own
 * choices (effort, speed: gateway/options.ts); `vision` sends images to a
 * model that takes them. */
export function gatewayModelClient(input: {
  baseUrl: string; apiKey: string; sessionId?: string; model?: string; contextWindow?: number; maxOutput?: number;
  vision?: boolean; options?: Readonly<Record<string, unknown>>; fetchImpl?: typeof fetch;
}): OpenAIModelClient {
  return new OpenAIModelClient({
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    apiKey: input.apiKey,
    model: input.model ?? 'auto',
    label: 'ClikDeploy Gateway',
    hosted: true,
    headers: { 'x-client': `clikcode/${CLIKCODE_VERSION}`, ...(input.sessionId ? { 'x-session-id': input.sessionId } : {}) },
    errorCodes: GATEWAY_ERROR_CODES,
    // A hosted model starts answering in seconds: the long first-chunk wait
    // is for a CPU reading a deep prompt, not for a stalled connection. The
    // Gateway sends a `: keepalive` comment every 15s while a step is open,
    // and every byte of one restarts the clock (gateway-client.ts readWithin),
    // so a step thinking or writing a long call is never cut and resent.
    firstChunkTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    limits: GATEWAY_REQUEST_LIMITS,
    describeError: gatewayErrorMessage,
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.maxOutput ? { maxOutputTokens: input.maxOutput } : {}),
    ...(input.vision ? { vision: true } : {}),
    ...(input.options && Object.keys(input.options).length ? { body: input.options } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

/** What the Gateway lists for the model this session will run (its pick, or
 * the Gateway's automatic one): its window, the most it writes in one answer,
 * and whether it takes images. */
async function gatewayModelFacts(session: HarnessSession, config: Conf): Promise<{ contextWindow?: number; maxOutput?: number; vision?: boolean }> {
  try {
    // Imported here: gateway/models.ts imports this module for gatewayConnection.
    const { savedGatewayModels, gatewayModels } = await import('../../gateway/models.js');
    // Model facts tune the local loop; the Gateway resolves the actual model.
    // A turn must not wait for a catalogue request before its first model step.
    let list = await savedGatewayModels({ config });
    const id = session.model ?? list?.automatic;
    let model = list?.models.find((entry) => entry.id === id);
    // An image requires a vision-capable model. Only this case needs a fresh
    // catalogue when the current account has no facts for the selected model.
    if (!model && session.attachments?.some((file) => /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i.test(file))) {
      list = await gatewayModels({ config });
      model = list.models.find((entry) => entry.id === (session.model ?? list?.automatic));
    }
    return {
      ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model?.maxOutput ? { maxOutput: model.maxOutput } : {}),
      ...(model?.vision ? { vision: true } : {}),
    };
  } catch {
    // fail-open-ok: the window only tunes the context profile, and without a
    // known vision model images stay described in text; the turn runs either way
    return {};
  }
}

/** The model client for a session that runs ClikCode's own agent. Async
 * because a local engine may have to load or start a model before its first
 * step. Throws, before any turn state is written, when the route cannot
 * serve a turn at all. */
export async function modelClientForSession(session: HarnessSession, config: Conf, local: LocalModelHooks = {}): Promise<ModelClient> {
  if (session.route === 'gateway') {
    const { baseUrl, apiKey } = gatewayConnection(config);
    const facts = await gatewayModelFacts(session, config);
    return gatewayModelClient({
      baseUrl, apiKey, sessionId: session.id, ...(session.model ? { model: session.model } : {}), ...facts,
      options: gatewayStepOptions(session),
    });
  }
  if (session.route === 'clikcode-local') {
    // Every process that may take a lease lets go of it on exit, so a
    // headless send's model does not wait for the supervisor's next sweep.
    releaseLocalModelsOnExit();
    // Joining a running server is a health check; only a cold start pays
    // for the download, the load and the one-time measurement.
    const endpoint = await ensureLocalModel({
      ...(session.model ? { modelId: session.model } : {}), sessionId: session.id,
      ...(local.progress ? { progress: local.progress } : {}),
    });
    if (endpoint.notice) local.notice?.(endpoint.notice);
    // A session with no pick runs what the engine chose; recording it keeps
    // later turns on the same model (another session's pick changes the
    // engine's default) and lets the status line name it. Persisted with
    // the turn's own state write.
    if (!session.model) session.model = endpoint.model;
    // CLIKCODE_LOCAL_PREFIX_CACHE=off reads the prefix from scratch on every
    // start, to rule the cache out when something looks wrong.
    const prefixes = endpoint.prefixCacheDir && process.env.CLIKCODE_LOCAL_PREFIX_CACHE !== 'off' ? prefixCacheFor(Number(new URL(endpoint.baseUrl).port), endpoint.prefixCacheDir, endpoint.promptPerSecond ? { promptPerSecond: endpoint.promptPerSecond } : {}) : undefined;
    return new OpenAIModelClient({
      // The engine's URL ends in /v1 and the client appends /v1 itself.
      baseUrl: endpoint.baseUrl.replace(/\/v1\/?$/, ''), model: endpoint.model,
      contextWindow: endpoint.contextWindow, label: CLIKCODE_LOCAL_LABEL,
      // The cache is part of the local-turn contract, not a server default:
      // unchanged history should be read once, on every supported machine.
      body: { cache_prompt: true },
      ...(endpoint.promptPerSecond ? { promptPerSecond: endpoint.promptPerSecond } : {}),
      // A cold server reads the system prompt and tools from a saved state
      // instead of from scratch (prefix-cache.ts).
      ...(prefixes ? { beforeRequest: (payload: Parameters<typeof prefixes.prepare>[0], signal?: AbortSignal) => prefixes.prepare(payload, signal) } : {}),
      onTimings: (timings, elapsedMs) => { void recordLocalTurnTiming(endpoint.model, timings, elapsedMs); },
    });
  }
  throw new Error(`a ${session.route} session runs a vendor harness, not ClikCode's own agent`);
}
