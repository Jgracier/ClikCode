/** What ClikCode reports about itself: models, usage, gateway status. */

import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { emitResult } from '../../cli/structured-output.js';
import { harnessCommand } from '../../session/state/paths.js';
import { readState } from '../../session/state/read.js';
import { CLIKCODE_USER_AGENT } from '../../version.js';

export async function aiModelsList(): Promise<void> {
  const state = await readState();
  emitResult({
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id,
      account: account.label,
      provider: account.provider,
      model,
      status: account.status,
    }))),
  });
}

export async function aiUsage(): Promise<void> {
  const state = await readState();
  const totals = state.invocations.reduce(
    (sum, invocation) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: sum.latencyMs + invocation.latencyMs,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  );
  emitResult({ ...totals, avgLatencyMs: totals.calls ? Math.round(totals.latencyMs / totals.calls) : 0, invocations: state.invocations });
}

/** Reports the separate ClikDeploy OAuth/API-key gateway identity, never a BYO provider login. */
export async function aiGatewayStatus(config: Conf): Promise<void> {
  const apiUrl = getApiUrl(config);
  const connected = Boolean(getApiKeyForUrl(config, apiUrl));
  emitResult({
    route: 'gateway',
    connected,
    apiUrl,
    authentication: 'oauth-or-api-key',
    credentialBoundary: 'gateway-auth-only',
    // How to connect is only worth saying to someone who is not.
    ...(connected ? {} : {
      hint: `Run \`${harnessCommand()} gateway login\` to connect ClikDeploy Gateway, or use \`${harnessCommand()} accounts add\` for a provider login that stays local.`,
    }),
  });
}

/** The signed-in account's AI use as ClikDeploy Gateway records it: every
 * surface, not only ClikCode, with the credit that gates the next call (or
 * `unlimited`). The Gateway owns the ledger; this only reads it. */
export async function aiGatewayUsage(config: Conf, options: { days?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<void> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) throw new Error(`Not signed in to ClikDeploy Gateway. Run \`${harnessCommand()} gateway login\`.`);
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 90)) throw new Error('--days must be a whole number from 1 to 90');
  const url = new URL('/api/clikcode/v1/usage', apiUrl);
  if (days !== undefined) url.searchParams.set('days', String(days));
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT } });
  const body = await response.json().catch(() => undefined) as { data?: unknown; error?: unknown; code?: unknown } | undefined;
  if (!response.ok || !body?.data) {
    // A Gateway that predates the endpoint answers 404.
    const reason = typeof body?.error === 'string' ? body.error : response.status === 404 ? 'this Gateway does not report usage yet' : `HTTP ${response.status}`;
    throw Object.assign(new Error(`ClikDeploy Gateway usage: ${reason}`), { statusCode: response.status });
  }
  emitResult({ apiUrl, ...(body.data as Record<string, unknown>) });
}
