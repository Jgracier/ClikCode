/** How a usage reading is worded wherever it is shown -- the terminal's
 * composer rule and the VS Code chat bar alike. Pure, with no terminal
 * dependency, so the extension's webview can use the same words. */
import { dollars } from '../../harness/protocol/format.js';

/** How much of an allowance is left, read out of the label ("42% left"). */
export function usageRemainingPercent(label?: string): number | undefined {
  if (!label) return undefined;
  const left = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*left/gi)].map((m) => Number(m[1]));
  return left.length ? Math.min(...left) : undefined;
}

/** What the composer rule says once the allowance is gone.
 *
 * A window that refills says when, in the same words as everywhere else
 * (`Resets 5:34PM`, or with the weekday and date when that is not today).
 * A balance that does not refill has no time to give, so it says so.
 * A percentage at zero is not shown: the reset, or the credit line, is the
 * whole message. */
export function composerUsageLabel(label?: string, resetLabel?: string): string | undefined {
  if (resetLabel) return resetLabel;
  if (label && !label.includes(' • ') && /credits exhausted|out of credits/i.test(label)) return 'Out Of Credits';
  return label;
}

/** "$1.23 this chat": what the conversation has cost, beside the account's
 * usage. The one number is the total of whatever was used (API, GPU, or both);
 * where it went is in /usage. Nothing when no turn reported a cost -- unknown is not $0. */
export function chatCostLabel(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return undefined;
  return `${dollars(costUsd)} this chat`;
}

/** `API $0.30`, `GPU $0.12`: where the credits went, for /usage. A side that spent
 * nothing is left out, and so is the whole split when the server sent none. */
export function costSplitParts(breakdown?: { meteredUsd?: number; gpuUsd?: number }): string[] {
  const part = (name: string, usd: number | undefined): string[] => (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? [`${name} ${dollars(usd)}`] : []);
  return [...part('API', breakdown?.meteredUsd), ...part('GPU', breakdown?.gpuUsd)];
}

/** Whether the reading says the allowance is spent (it is then drawn red). */
export function usageLabelIsSpent(label?: string): boolean {
  if (!label) return false;
  if (/^resets\b/i.test(label) || label === 'Out Of Credits' || /• Out of credits$/.test(label)) return true;
  const remaining = usageRemainingPercent(label);
  return /exhausted/i.test(label) || (remaining !== undefined && remaining <= 0);
}
