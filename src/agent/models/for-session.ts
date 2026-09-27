/** Which model client feeds ClikCode's own agent for a session.
 *
 * The agent loop (run-turn.ts) is the same whichever inference is behind it;
 * only this choice differs by route. Keeping it in one function means the
 * turn path never asks "which route?" to build a client, and ClikCode Local's
 * engine plugs in here and nowhere else. */

import type Conf from 'conf';
import type { ModelClient } from '../model-client.js';
import { GatewayModelClient } from './gateway-client.js';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { harnessCommand } from '../../session/state/paths.js';
import { CLIKCODE_VERSION } from '../../version.js';
import type { HarnessSession } from '../../session/model.js';

export const CLIKCODE_LOCAL_NOT_INSTALLED = "ClikCode Local's engine is not installed in this build yet. Choose ClikDeploy Gateway or a provider with /provider.";

/** The Gateway's base URL and the credential for it, or the error that says
 * how to connect. Exported so the platform-assistant fallback, which talks to
 * the same service, resolves them identically. */
export function gatewayConnection(config: Conf): { baseUrl: string; apiKey: string } {
  const baseUrl = getApiUrl(config).replace(/\/$/, '');
  const apiKey = getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  return { baseUrl, apiKey };
}

/** The model client for a session that runs ClikCode's own agent. Async
 * because a local engine may have to load or start a model before its first
 * step. Throws, before any turn state is written, when the route cannot
 * serve a turn at all. */
export async function modelClientForSession(session: HarnessSession, config: Conf): Promise<ModelClient> {
  if (session.route === 'gateway') {
    const { baseUrl, apiKey } = gatewayConnection(config);
    return new GatewayModelClient({ baseUrl, apiKey, version: CLIKCODE_VERSION, sessionId: session.id });
  }
  if (session.route === 'clikcode-local') {
    // The seam the local-model engine fills: it will resolve the session's
    // model through the engine and return an OpenAIModelClient pointed at it.
    throw new Error(CLIKCODE_LOCAL_NOT_INSTALLED);
  }
  throw new Error(`a ${session.route} session runs a vendor harness, not ClikCode's own agent`);
}
