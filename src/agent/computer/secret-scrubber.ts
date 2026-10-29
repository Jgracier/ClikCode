import { sharedState } from './shared-state.js';
/** Every secret value this process has held, in the forms it could reappear in,
 * so no tool result, event or log can carry one back to the model. This is an
 * exact match, not a guess at what a key looks like. */
const live = sharedState('secrets-live', () => new Map<string, string>());
const MASK = '[secret hidden]';

function forms(value: string): string[] {
  const out = new Set([value, value.trim(), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  return [...out].filter(form => form.length >= 4);
}

/** Values seen on a page that must not reach the model (a key in a table cell, a code block, a data attribute), each with a stable
 * placeholder `[secret:ref-N]`. The model can aim capture_secret at the placeholder; the value stays here. */
const refs = sharedState('secret-refs', () => ({ byValue: new Map<string, number>(), byNumber: new Map<number, string>() }));
const REF_TEXT = /^\[?secret:ref-(\d+)\]?$/;

/** The stable placeholder for a value, remembering it so every later text is scrubbed of it too. */
export function secretRef(value: string): string {
  let n = refs.byValue.get(value);
  if (n === undefined) { n = refs.byValue.size + 1; refs.byValue.set(value, n); refs.byNumber.set(n, value); }
  return `[secret:ref-${n}]`;
}
/** The value behind a `[secret:ref-N]` placeholder (or `secret:ref-N`), for capture_secret only. */
export function resolveSecretRef(ref: string): string | undefined {
  const match = REF_TEXT.exec(ref.trim());
  return match ? refs.byNumber.get(Number(match[1])) : undefined;
}
export const isSecretRef = (text: string): boolean => REF_TEXT.test(text.trim());

export function registerSecret(value: string): void {
  for (const form of forms(value)) live.set(form, value);
}

export function scrubSecrets(text: string): string {
  if (!live.size && !refs.byValue.size) return text;
  let out = text;
  for (const value of [...refs.byValue.keys()].sort((a, b) => b.length - a.length)) if (out.includes(value)) out = out.split(value).join(secretRef(value));
  // Longest first, so a form that contains another is replaced whole.
  for (const form of [...live.keys()].sort((a, b) => b.length - a.length)) if (out.includes(form)) out = out.split(form).join(MASK);
  return out;
}

export function forgetSecrets(): void { live.clear(); refs.byValue.clear(); refs.byNumber.clear(); }

/** True when the text carries a held secret in any form, so a picture of the same page must be withheld. */
export function showsSecret(text: string): boolean {
  return (live.size > 0 || refs.byValue.size > 0) && scrubSecrets(text) !== text;
}
