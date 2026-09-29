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
/** The reason in a Gateway error body: OpenAI's `{ error: { message } }`, or
 * the platform's `{ error: "..." }`; else the status, or `missing` for a 404
 * from a Gateway older than the endpoint. */
function gatewayErrorReason(body: { error?: unknown } | undefined, status: number, missing: string): string {
  const error = body?.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return status === 404 ? missing : `HTTP ${status}`;
}

/** What the signed-in account used through the Gateway, per model, and the
 * credit it is paid from (`GET /v1/usage` and `GET /v1/credits`). */
export async function aiGatewayUsage(config: Conf, options: { days?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<void> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) throw new Error(`Not signed in to ClikDeploy Gateway. Run \`${harnessCommand()} gateway login\`.`);
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 90)) throw new Error('--days must be a whole number from 1 to 90');
  const url = new URL('/v1/usage', apiUrl);
  if (days !== undefined) url.searchParams.set('days', String(days));
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT };
  const [response, creditResponse] = await Promise.all([fetchImpl(url, { headers }), fetchImpl(new URL('/v1/credits', apiUrl), { headers })]);
  const body = await response.json().catch(() => undefined) as { data?: unknown; error?: unknown } | undefined;
  if (!response.ok || !body?.data) {
    throw Object.assign(new Error(`ClikDeploy Gateway usage: ${gatewayErrorReason(body, response.status, 'this Gateway does not report usage yet')}`), { statusCode: response.status });
  }
  const credit = await creditResponse.json().catch(() => undefined) as { data?: unknown } | undefined;
  emitResult({ apiUrl, ...(body.data as Record<string, unknown>), ...(creditResponse.ok && credit?.data ? { credit: credit.data } : {}) });
}

/** Buy AI credit for the signed-in account: the Gateway returns a Stripe
 * Checkout page, opened here when there is a display to open it on. Paying it
 * adds the credit and saves the card for later top-ups. */
export async function aiGatewayCredit(
  config: Conf,
  options: { amount?: string; autoTopup?: string } = {},
  deps: { fetchImpl?: typeof fetch; open?: (url: string) => void; environment?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) throw new Error(`Not signed in to ClikDeploy Gateway. Run \`${harnessCommand()} gateway login\`.`);
  if (options.autoTopup !== undefined) {
    await setAutoTopUp(apiUrl, apiKey, options.autoTopup, deps.fetchImpl ?? fetch);
    return;
  }
  const amountUsd = options.amount === undefined ? undefined : Number(options.amount);
  if (amountUsd !== undefined && (!Number.isInteger(amountUsd) || amountUsd < 5 || amountUsd > 500)) {
    throw new Error('--amount must be a whole number of dollars from 5 to 500');
  }
  const response = await (deps.fetchImpl ?? fetch)(new URL('/v1/credits/checkout', apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify(amountUsd === undefined ? {} : { amountUsd }),
  });
  const body = await response.json().catch(() => undefined) as { data?: { url?: unknown; amountCents?: unknown }; error?: unknown } | undefined;
  const url = typeof body?.data?.url === 'string' ? body.data.url : undefined;
  if (!response.ok || !url) {
    throw Object.assign(new Error(`ClikDeploy Gateway credit: ${gatewayErrorReason(body, response.status, 'this Gateway does not sell credit yet')}`), { statusCode: response.status });
  }
  const { hasLocalDisplay, openLoginUrl } = await import('../../gateway/login/url.js');
  const opened = hasLocalDisplay(deps.environment ?? process.env);
  if (opened) (deps.open ?? openLoginUrl)(url);
  emitResult({ apiUrl, checkoutUrl: url, amountCents: body?.data?.amountCents ?? null, opened });
}

/** Turn automatic top-up on or off: the saved card is charged for more credit
 * when it runs low. The same switch as the billing settings page. */
async function setAutoTopUp(apiUrl: string, apiKey: string, value: string, fetchImpl: typeof fetch): Promise<void> {
  const word = value.trim().toLowerCase();
  if (word !== 'on' && word !== 'off') throw new Error('--auto-topup must be on or off');
  const response = await fetchImpl(new URL('/v1/credits', apiUrl), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify({ autoTopUpEnabled: word === 'on' }),
  });
  const body = await response.json().catch(() => undefined) as { data?: { autoTopUpEnabled?: unknown }; error?: unknown } | undefined;
  if (!response.ok || typeof body?.data?.autoTopUpEnabled !== 'boolean') {
    throw Object.assign(new Error(`ClikDeploy Gateway auto top-up: ${gatewayErrorReason(body, response.status, 'this Gateway does not offer automatic top-up yet')}`), { statusCode: response.status });
  }
  emitResult({ apiUrl, autoTopUpEnabled: body.data.autoTopUpEnabled });
}

/** The models ClikDeploy Gateway offers the signed-in account, cheapest access
 * first -- what `/model` and `sessions set --model` choose from. */
export async function aiGatewayModels(config: Conf): Promise<void> {
  const { gatewayModels, gatewayPriceLabel } = await import('../../gateway/models.js');
  const { automatic, models } = await gatewayModels({ config, fresh: true });
  emitResult({
    automatic,
    // The model, its price and what it can do: which provider serves it is the Gateway's decision.
    models: models.map((model) => ({
      id: model.id,
      ...(model.price ? { price: gatewayPriceLabel(model.price), priceUsdPerMTok: model.price } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
      ...(model.vision ? { vision: true } : {}),
      ...(model.reasoning ? { reasoning: true } : {}),
      ...(model.tokensPerSecond ? { tokensPerSecond: model.tokensPerSecond } : {}),
    })),
  });
}
