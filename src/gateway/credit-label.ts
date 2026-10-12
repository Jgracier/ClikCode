/** The Gateway's credit, worded for the composer rule: where a vendor lane
 * shows how much of its plan's window is left ("5h 96% left"), a Gateway
 * conversation shows what its calls are paid from. */
import type Conf from 'conf';
import { gatewayStatus } from '../ide/queries.js';
import { dollars } from '../harness/protocol/format.js';

/** A reading is reused this long: the rule asks every 15 seconds, and the
 * balance only moves when a turn is billed. */
const CREDIT_TTL_MS = 60_000;
let cached: { at: number; label: string | undefined } | undefined;

/** `$4.50 credit left`, `Out of credits`, or `Unlimited credit` for an account that is not metered.
 * Nothing for one that is not connected or a Gateway that did not answer: a figure the Gateway did
 * not give is never made up. Both the terminal's rule and the extension's bar read this. */
export async function gatewayCreditLabel(config: Conf, options: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<string | undefined> {
  if (!options.fresh && cached && Date.now() - cached.at < CREDIT_TTL_MS) return cached.label;
  const status = await gatewayStatus(config, options.fetchImpl);
  const credit = status.credit;
  const label = !credit ? undefined
    : credit.unlimited ? 'Unlimited credit'
      : credit.balanceUsd === undefined ? undefined
        : credit.balanceUsd <= 0 || credit.allowed === false ? 'Out of credits'
          : `${dollars(credit.balanceUsd)} credit left`;
  cached = { at: Date.now(), label };
  return label;
}

/** Test seam. */
export function resetGatewayCreditLabel(): void {
  cached = undefined;
}
