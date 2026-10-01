/** How a usage reading is worded wherever it is shown -- the terminal's
 * composer rule and the VS Code chat bar alike. Pure, with no terminal
 * dependency, so the extension's webview can use the same words. */

/** How much of an allowance is left, read out of the label the harness gave.
 * Both forms appear: "42% left" and the legacy "58% used". */
export function usageRemainingPercent(label?: string): number | undefined {
  if (!label) return undefined;
  const left = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*left/gi)].map((m) => Number(m[1]));
  if (left.length) return Math.min(...left);
  const used = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*used/gi)].map((m) => Number(m[1]));
  return used.length ? 100 - Math.max(...used) : undefined;
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
  if (label && /credits exhausted|out of credits/i.test(label)) return 'Out Of Credits';
  return label;
}

/** Whether the reading says the allowance is spent (it is then drawn red). */
export function usageLabelIsSpent(label?: string): boolean {
  if (!label) return false;
  if (/^resets\b/i.test(label) || label === 'Out Of Credits') return true;
  const remaining = usageRemainingPercent(label);
  return /exhausted/i.test(label) || (remaining !== undefined && remaining <= 0);
}
