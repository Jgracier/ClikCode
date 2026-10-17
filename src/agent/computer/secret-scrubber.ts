/** Every secret value this process has held, in the forms it could reappear in,
 * so no tool result, event or log can carry one back to the model. This is an
 * exact match, not a guess at what a key looks like. */
const live = new Map<string, string>();
const MASK = '[secret hidden]';

function forms(value: string): string[] {
  const out = new Set([value, value.trim(), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  return [...out].filter(form => form.length >= 4);
}

export function registerSecret(value: string): void {
  for (const form of forms(value)) live.set(form, value);
}

export function scrubSecrets(text: string): string {
  if (!live.size) return text;
  let out = text;
  // Longest first, so a form that contains another is replaced whole.
  for (const form of [...live.keys()].sort((a, b) => b.length - a.length)) if (out.includes(form)) out = out.split(form).join(MASK);
  return out;
}

export function forgetSecrets(): void { live.clear(); }

/** True when the text carries a held secret in any form, so a picture of the same page must be withheld. */
export function showsSecret(text: string): boolean {
  return live.size > 0 && scrubSecrets(text) !== text;
}
