/** The Gateway's credit, worded for the composer rule: where a vendor lane
 * shows how much of its plan's window is left ("5h 96% left"), a Gateway
 * conversation shows what its calls are paid from. */
import type Conf from 'conf';
import { creditOf, gatewayStatus } from '../ide/queries.js';
import { getApiKeyForUrl, getApiUrl } from './credentials.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { dollars } from '../harness/protocol/format.js';

/** A reading is reused this long: the rule asks every 15 seconds, and the
 * balance only moves when a turn is billed. */
const CREDIT_TTL_MS = 60_000;
let cached: { at: number; label: string | undefined } | undefined;

/** What the account's ClikCode use cost in all (at model prices, whoever paid), and its credit, from the Gateway's own
 * ledger (`GET /api/clikcode/v1/usage`, `lifetimeCostMicroUsd`). Undefined when it did
 * not answer: a figure the Gateway did not give is never made up. */
async function usageReading(config: Conf, fetchImpl: typeof fetch): Promise<{ usedUsd: number; credit: ReturnType<typeof creditOf> } | undefined> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) return undefined;
  try {
    const response = await fetchImpl(new URL('/api/clikcode/v1/usage?days=1', apiUrl), {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => undefined) as { data?: { credit?: Record<string, unknown>; lifetimeCostMicroUsd?: unknown } } | undefined;
    const charged = Number(body?.data?.lifetimeCostMicroUsd);
    if (!response.ok || !body?.data?.credit || !Number.isFinite(charged)) return undefined;
    return { usedUsd: charged / 1_000_000, credit: creditOf(body.data.credit) };
  } catch { return undefined; }
}

/** `$65.42 used • $12.45 available` (used: all the account has been charged), `… • Out of credits`, or `… • Unlimited`
 * for an account that is not metered. Where the ledger gave no spend, `$4.50 credit left` from the
 * balance alone. Nothing for one that is not connected or a Gateway that did not answer. Both the
 * terminal's rule and the extension's bar read this. */
export async function gatewayCreditLabel(config: Conf, options: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<string | undefined> {
  if (!options.fresh && cached && Date.now() - cached.at < CREDIT_TTL_MS) return cached.label;
  const fetchImpl = options.fetchImpl ?? fetch;
  const reading = await usageReading(config, fetchImpl);
  const credit = reading?.credit ?? (await gatewayStatus(config, fetchImpl)).credit;
  const used = reading ? `${dollars(reading.usedUsd)} used` : undefined;
  const left = !credit ? undefined
    : credit.unlimited ? 'Unlimited'
      : credit.balanceUsd === undefined ? undefined
        : credit.balanceUsd <= 0 || credit.allowed === false ? 'Out of credits'
          : `${dollars(credit.balanceUsd)} available`;
  const label = !left ? undefined : used ? `${used} • ${left}` : left === 'Unlimited' ? 'Unlimited credit' : left.endsWith('available') ? left.replace(' available', ' credit left') : left;
  cached = { at: Date.now(), label };
  return label;
}

/** Test seam. */
export function resetGatewayCreditLabel(): void {
  cached = undefined;
}
