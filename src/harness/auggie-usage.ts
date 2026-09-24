/**
 * Augment Auggie's own account balance, read from the harness.
 *
 * `auggie account status --json` reports the account's credit balance
 * directly, which makes Auggie one of the few harnesses besides Claude Code
 * and Codex that can answer "how much is left?" without ClikCode calling a
 * vendor API behind the harness's back.
 *
 * Verified against a real account on this machine:
 *
 *   { "planName": "Free Plan", "usageUnit": "usd", "amountRemaining": "0",
 *     "amountIncludedPerCycle": "0",
 *     "billingCycleEndDate": "2026-10-21T19:55:49Z",
 *     "daysRemainingInCycle": 29 }
 *
 * This is a spend balance, not a percentage window: there is no "83% left"
 * to report, so the label says what the vendor actually measures.
 */

interface AuggieAccountStatus {
  planName?: unknown;
  usageUnit?: unknown;
  amountRemaining?: unknown;
  amountIncludedPerCycle?: unknown;
  billingCycleEndDate?: unknown;
}

/** Currency amounts arrive as strings ("0", "12.50"); anything unparseable is
 * not guessed at. */
function amount(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function money(value: number, unit: string | undefined): string {
  const symbol = (unit ?? '').toLowerCase() === 'usd' ? '$' : '';
  // Whole dollars stay whole; cents matter when they are all that is left.
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return symbol ? `${symbol}${text}` : `${text}${unit ? ` ${unit}` : ''}`;
}

/** The usage label for an Auggie account, or undefined when the payload does
 * not carry a balance. Exhaustion is reported in the words every harness uses
 * for it, so the composer reads the same whatever is behind it. */
export function auggieUsageLabel(raw: string): string | undefined {
  let parsed: AuggieAccountStatus;
  try { parsed = JSON.parse(raw) as AuggieAccountStatus; } catch { return undefined; }
  const remaining = amount(parsed.amountRemaining);
  if (remaining === undefined) return undefined;
  const unit = typeof parsed.usageUnit === 'string' ? parsed.usageUnit : undefined;
  if (remaining <= 0) return 'Out Of Credits';
  return `${money(remaining, unit)} credits left`;
}
