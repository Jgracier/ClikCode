/** Which model client feeds ClikCode's own agent for a session.
 *
 * The agent loop (run-turn.ts) is the same whichever inference is behind it;
 * only this choice differs by route. Keeping it in one function means the
 * turn path never asks "which route?" to build a client, and ClikCode Local's
 * engine (src/local-models) plugs in here and nowhere else. */

import type Conf from 'conf';
import type { ModelClient } from '../model-client.js';
import { GatewayModelClient } from './gateway-client.js';
import { OpenAIModelClient } from './openai-client.js';
import { ensureLocalModel, releaseLocalModelsOnExit, type LocalModelProgress } from '../../local-models/index.js';
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
 * how to connect. Exported so the platform-assistant fallback, which talks to
 * the same service, resolves them identically. */
export function gatewayConnection(config: Conf): { baseUrl: string; apiKey: string } {
  const baseUrl = getApiUrl(config).replace(/\/$/, '');
  const apiKey = getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  return { baseUrl, apiKey };
}

/** How long a turn waits on the Gateway's model list for a window. The list
 * is cached for a minute and usually already fetched by the model picker;
 * a slow answer must not hold up the turn, and without it the Gateway
 * client still says it is hosted (context-profile.ts). */
const MODEL_LIST_WAIT_MS = 2_000;

/** The context window the Gateway lists for the model this session will run
 * (its pick, or the Gateway's automatic one), when it lists one. */
async function gatewayModelWindow(session: HarnessSession, config: Conf): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Imported here: gateway/models.ts imports this module for gatewayConnection.
    const { gatewayModels } = await import('../../gateway/models.js');
    const list = await Promise.race([
      gatewayModels({ config }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), MODEL_LIST_WAIT_MS); timer.unref(); }),
    ]);
    const id = session.model ?? list?.automatic;
    return list?.models.find((model) => model.id === id)?.contextWindow;
  } catch {
    // fail-open-ok: the window only tunes the context profile; the turn runs without it
    return undefined;
  } finally { clearTimeout(timer); }
}

/** The model client for a session that runs ClikCode's own agent. Async
 * because a local engine may have to load or start a model before its first
 * step. Throws, before any turn state is written, when the route cannot
 * serve a turn at all. */
export async function modelClientForSession(session: HarnessSession, config: Conf, local: LocalModelHooks = {}): Promise<ModelClient> {
  if (session.route === 'gateway') {
    const { baseUrl, apiKey } = gatewayConnection(config);
    const contextWindow = await gatewayModelWindow(session, config);
    return new GatewayModelClient({
      baseUrl, apiKey, version: CLIKCODE_VERSION, sessionId: session.id,
      ...(contextWindow ? { contextWindow } : {}),
      // The model the user chose from the Gateway's list, served from its
      // cheapest provider; none, and the Gateway picks.
      ...(session.model ? { model: session.model } : {}),
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
    return new OpenAIModelClient({
      // The engine's URL ends in /v1 and the client appends /v1 itself.
      baseUrl: endpoint.baseUrl.replace(/\/v1\/?$/, ''), model: endpoint.model,
      contextWindow: endpoint.contextWindow, label: CLIKCODE_LOCAL_LABEL,
      ...(endpoint.promptPerSecond ? { promptPerSecond: endpoint.promptPerSecond } : {}),
    });
  }
  throw new Error(`a ${session.route} session runs a vendor harness, not ClikCode's own agent`);
}
