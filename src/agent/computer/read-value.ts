/** Reading a plain value a page labels (Knack's Application ID, a Subdomain, a Workspace ID) without running JavaScript.
 *
 * The page view hides anything key-shaped, so an id that looks like a key could only be read by `evaluate`. This reads it in
 * the page, refuses anything that is a secret (a label naming a key, secret, token or password; a long opaque string), and
 * for an opaque id decides where it goes: a short human value is returned, an id that looks like a token is saved in the
 * vault and returned only as a `secret:<name>` reference for send_to `values`, so the model never has to see it. */
import type { Page } from 'playwright-core';
import { keyShaped } from './secret-finder.js';

const SECRET_LABEL = /key|secret|token|password|passcode|credential|private/i;
/** A label for the id of a thing ("API key id" is still refused: it names a key). */
export type ValueJudgement = { ok: true; hidden: boolean } | { ok: false; reason: string };

const entropy = (text: string): number => {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum - (n / text.length) * Math.log2(n / text.length), 0);
};

/** Is this labelled value fit to read? `hidden` = it looks like an opaque id, so it is kept out of the conversation. */
export function judgeValue(label: string, value: string): ValueJudgement {
  const text = value.trim();
  if (!text) return { ok: false, reason: 'the value is empty' };
  if (SECRET_LABEL.test(label)) return { ok: false, reason: `"${label}" names a secret; use capture_secret, which saves it without showing it` };
  if (/\s/.test(text) && text.length > 80) return { ok: false, reason: 'that is a block of text, not a single value' };
  if (!/\s/.test(text) && text.length > 40 && (entropy(text) > 3.2 || keyShaped(text))) return { ok: false, reason: 'it is a long opaque string that looks like a secret; use capture_secret' };
  const opaque = !/\s/.test(text) && text.length >= 16 && /\d/.test(text) && /[a-z]/i.test(text);
  return { ok: true, hidden: opaque };
}

/** Values the page puts beside a label: a label element's field, a definition or table cell next to it, a field named by it, or the rest of its row. */
export async function labelledCandidates(page: Page, label: string): Promise<string[]> {
  return page.evaluate((wanted: string) => {
    const g = globalThis as unknown as { document: any };
    const doc = g.document;
    const norm = (s: string): string => s.replace(/\s+/g, ' ').replace(/[:*]+\s*$/, '').trim().toLowerCase();
    const want = norm(wanted);
    const out: string[] = [];
    const add = (s: unknown): void => { const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; if (t && t.length <= 300 && norm(t) !== want && !out.includes(t)) out.push(t); };
    const fieldValue = (el: any): string => (el && el.type !== 'password' && 'value' in el && el.value) || '';
    for (const input of doc.querySelectorAll('input:not([type=password]), textarea')) {
      const hay = [input.getAttribute('aria-label'), input.getAttribute('placeholder'), input.getAttribute('name'), input.id].map(v => norm(v ?? ''));
      const labels = [...(input.labels ?? [])].map((l: any) => norm(l.textContent ?? ''));
      if ([...hay, ...labels].some(v => v === want)) add(fieldValue(input));
    }
    const nodes = [...doc.querySelectorAll('label, dt, th, td, span, div, p, strong, b, h1, h2, h3, h4, h5, h6, li')];
    for (const node of nodes) {
      const own = [...node.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join(' ');
      const whole = node.textContent ?? '';
      const isLabel = norm(own) === want || (node.children.length === 0 && norm(whole) === want) || (node.children.length <= 1 && norm(whole) === want);
      if (isLabel) {
        add(fieldValue(node.control));
        const next = node.nextElementSibling;
        if (next) { add(fieldValue(next) || fieldValue(next.querySelector?.('input, textarea'))); add(next.textContent); }
        const row = node.parentElement;
        if (row && row.children.length <= 4) for (const c of row.children) if (c !== node) { add(fieldValue(c) || fieldValue(c.querySelector?.('input, textarea'))); add(c.textContent); }
      } else if (node.children.length === 0) {
        // "Application ID: 5f1c2d3e4a" in one element
        const m = new RegExp('^' + wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*(\\S[^\\n]*)$', 'i').exec(whole.trim());
        if (m) add(m[1]);
      }
    }
    return out.slice(0, 10);
  }, label);
}

export type ReadValueResult = { kind: 'value'; value: string } | { kind: 'hidden'; value: string; reason?: undefined } | { kind: 'refused'; reason: string };

/** The first candidate that passes; if there are candidates and none passes, the reason of the first. */
export function chooseValue(label: string, candidates: readonly string[]): ReadValueResult & { alternatives?: number } {
  let reason = '';
  for (const candidate of candidates) {
    const judged = judgeValue(label, candidate);
    if (judged.ok) return { kind: judged.hidden ? 'hidden' : 'value', value: candidate.trim(), alternatives: candidates.length - 1 };
    reason ||= judged.reason;
  }
  return { kind: 'refused', reason: reason || `no value labelled "${label}" is on the page` };
}
