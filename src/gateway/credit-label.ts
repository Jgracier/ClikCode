/** The Gateway's credit, worded for the composer rule: where a vendor lane
 * shows how much of its plan's window is left ("5h 96% left"), a Gateway
 * conversation shows what its calls are paid from. */
import type Conf from 'conf';
import { gatewayStatus } from '../ide/queries.js';
import { dollars } from '../harness/protocol/format.js';
import { chatCostLabel } from '../tui/render/usage-words.js';

/** A reading is reused this long: the rule asks every 15 seconds, and the
 * balance only moves when a turn is billed. */
const CREDIT_TTL_MS = 60_000;
let cached: { at: number; label: string | undefined } | undefined;

/** The account's remaining Gateway credit. Conversation spend comes from
 * ClikCode's per-session invocation ledger, never the account's lifetime. */
export async function gatewayCreditLabel(config: Conf, options: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<string | undefined> {
  if (!options.fresh && cached && Date.now() - cached.at < CREDIT_TTL_MS) return cached.label;
  const fetchImpl = options.fetchImpl ?? fetch;
  const credit = (await gatewayStatus(config, fetchImpl)).credit;
  const left = !credit ? undefined
    : credit.unlimited ? 'Unlimited'
      : credit.balanceUsd === undefined ? undefined
        : credit.balanceUsd <= 0 || credit.allowed === false ? 'Out of credits'
          : `${dollars(credit.balanceUsd)} credit left`;
  const label = left === 'Unlimited' ? 'Unlimited credit' : left;
  cached = { at: Date.now(), label };
  return label;
}

/** The terminal composer shows this chat's recorded cost beside the account
 * balance. The editor renders the same two facts in separate status slots. */
export function gatewayConversationUsageLabel(costUsd: number | undefined, creditLabel: string | undefined, breakdown?: { meteredUsd?: number; gpuUsd?: number }): string | undefined {
  const parts = [chatCostLabel(costUsd, breakdown), creditLabel].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' • ') : undefined;
}

/** Test seam. */
export function resetGatewayCreditLabel(): void {
  cached = undefined;
}
