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

/** `$4.50 credit left`, `Out of credits`, or nothing for an unlimited account,
 * one that is not connected, or a Gateway that did not answer. */
export async function gatewayCreditLabel(config: Conf, options: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<string | undefined> {
  if (!options.fresh && cached && Date.now() - cached.at < CREDIT_TTL_MS) return cached.label;
  const status = await gatewayStatus(config, options.fetchImpl);
  const credit = status.credit;
  const label = !credit || credit.unlimited || credit.balanceUsd === undefined ? undefined
    : credit.balanceUsd <= 0 || credit.allowed === false ? 'Out of credits'
      : `${dollars(credit.balanceUsd)} credit left`;
  cached = { at: Date.now(), label };
  return label;
}

/** Test seam. */
export function resetGatewayCreditLabel(): void {
  cached = undefined;
}
