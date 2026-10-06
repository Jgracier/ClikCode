/** Private agents published for the currently connected Gateway account. */

import Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

export interface GatewayAgent { id: string; name: string; description?: string }

export async function gatewayAgents(options: { config?: Conf; fetchImpl?: typeof fetch } = {}): Promise<GatewayAgent[]> {
  const { baseUrl, apiKey } = gatewayConnection(options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/agents`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`ClikDeploy Gateway agents: HTTP ${response.status}`);
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) throw new Error('ClikDeploy Gateway agents: invalid roster response');
  // The server scopes this list to the key's account. Do not cache it on disk:
  // another account may connect to the same URL on this machine.
  return (body as { data: unknown[] }).data.flatMap((value): GatewayAgent[] => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as { id?: unknown; name?: unknown; description?: unknown; enabled?: unknown };
    // A switched-off agent is still listed for managing it, but there is no talking to it.
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name || entry.enabled === false) return [];
    return [{ id: entry.id, name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }];
  });
}
