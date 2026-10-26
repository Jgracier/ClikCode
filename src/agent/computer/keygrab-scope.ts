/** When a key-creation form offers a role, scope, team or permission selector, the key is made on the user's own test account with the
 * BROADEST choice it offers (Admin, Owner, Full access, All scopes, Global), never a narrower one: a narrow key would fail the connector's
 * live tests for a reason nobody can see. Destructive account-level settings ("Delete account") are never chosen. Pure; the policy applies it. */
import type { KeyControl } from './keygrab.js';

/** The control that opens a selector for a role, scope, team or permission ("Select a team", "Select a role", "Permissions"). */
const SELECTOR = /^(?:select|choose|pick)\b[^.]{0,30}\b(?:team|role|scopes?|permissions?|access(?: level)?|privileges?|workspace|organi[sz]ation|project|account|plan)\b|^(?:role|scopes?|permissions?|access(?: level)?|privileges?)\s*(?:\*|:)?$/i;
/** A control that grants everything in one press. */
const ALL_AT_ONCE = /^(?:select all|check all|grant all|all scopes|all permissions|full access)$/i;
/** An option that deletes or closes something: never chosen, whatever else it says. */
const DESTRUCTIVE = /\b(?:delete|remove|close|deactivate|terminate|cancel|destroy|erase|wipe|revoke)\b|danger|\bdisable (?:my )?account\b/i;

/** How broad an option reads: 0 means it is not recognised as broad (or is destructive). */
export function breadth(option: string): number {
  const o = option.replace(/\s+/g, ' ').trim();
  if (!o || o.length > 80 || DESTRUCTIVE.test(o)) return 0;
  if (/\b(?:full access|all scopes|all permissions|unrestricted|everything|read[ ,/&-]+write[ ,/&-]+admin)\b/i.test(o)) return 100;
  if (/\bowner\b|\bsuper ?admin/i.test(o)) return 95;
  if (/^admin(?:istrator)?\b/i.test(o)) return 90;
  if (/^global\b|\bglobal \(|account[- ]wide|\ball (?:teams|projects|workspaces|resources|organi[sz]ations|access)\b/i.test(o)) return 80;
  if (/\b(?:admin|owner|full)\b/i.test(o)) return 60;
  if (/\ball\b/i.test(o)) return 40;
  return 0;
}

/** The broadest of the options on offer, or undefined when none reads as broad (then nothing is chosen: a guess could be narrower). */
export function broadestOption(options: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const name of options) { const score = breadth(name); if (score > 0 && (!best || score > best.score)) best = { name, score }; }
  return best?.name;
}

/** The selectors a form shows that have not been handled yet. */
export function selectorsOf(controls: readonly KeyControl[], done: ReadonlySet<string>): KeyControl[] {
  return controls.filter(c => !done.has(c.name) && c.name.length <= 60 && !DESTRUCTIVE.test(c.name) && (SELECTOR.test(c.name.trim()) || (c.menu === true && /\b(?:role|scopes?|permissions?|access level|team)\b/i.test(c.name))));
}

/** The control that grants everything in one press, if the form has one. */
export function allAtOnce(controls: readonly KeyControl[], done: ReadonlySet<string>): KeyControl | undefined {
  return controls.find(c => !done.has(c.name) && ALL_AT_ONCE.test(c.name.trim()));
}

/** The options a selector revealed: the controls that were not on the page before it was opened. */
export function revealedOptions(before: readonly KeyControl[], after: readonly KeyControl[]): string[] {
  const had = new Set(before.map(c => c.name));
  return after.filter(c => !had.has(c.name) && c.name.length <= 80).map(c => c.name);
}
