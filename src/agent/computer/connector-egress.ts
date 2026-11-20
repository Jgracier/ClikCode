/** Which way out (egress.ts) each vendor's connector run leaves through. A vendor stopped by a captcha wall is tried again through the next
 * egress it has not been tried on; one that got through somewhere keeps that egress first for its later runs (repairs, sign-ins again).
 * Once every egress was tried the wall stands as before, and the next run starts over from the vendor's best. The choice is data here; the
 * loop (connector-loop.ts) asks and reports, and this file keeps the record (~/.clikcode state, computer/egress-vendors.json). */
import path from 'node:path';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';
import { readFile } from 'node:fs/promises';
import { HOME_EGRESS } from './settings.js';

export interface VendorEgress {
  /** The egress that last got this vendor past its browser work: tried first. */ egress?: string;
  /** Egresses this vendor met a captcha wall on, in this round. */ tried: string[];
  at: string;
}
export type EgressRunResult = 'captcha' | 'worked' | 'other';

/** Captcha walls older than this no longer count against an egress for the vendor (the site may have cooled). */
export const TRIED_FOR_MS = 24 * 3_600_000;

const fresh = (state: VendorEgress | undefined, now: number): string[] => state && now - Date.parse(state.at) < TRIED_FOR_MS ? state.tried : [];

/** The egress a vendor's next run uses, and whether another is left to try after it. `names` are the egresses in order, home first. */
export function pickEgress(state: VendorEgress | undefined, names: readonly string[], now = Date.now()): { egress: string; another: boolean } {
  const preferred = state?.egress && names.includes(state.egress) ? state.egress : undefined;
  const order = preferred ? [preferred, ...names.filter(name => name !== preferred)] : [...names];
  const tried = fresh(state, now);
  const left = order.filter(name => !tried.includes(name));
  if (!left.length) return { egress: order[0] ?? HOME_EGRESS, another: false };
  return { egress: left[0]!, another: left.length > 1 };
}

/** The vendor's record after a run on `egress`: a captcha wall marks it tried (every egress tried: the round is over and starts again);
 * a run that got through makes it the vendor's egress. Undefined: nothing to keep. */
export function afterRun(state: VendorEgress | undefined, egress: string, result: EgressRunResult, names: readonly string[], now = Date.now()): VendorEgress | undefined {
  const at = new Date(now).toISOString();
  const keep = state?.egress && names.includes(state.egress) ? { egress: state.egress } : {};
  if (result === 'worked') return egress === HOME_EGRESS && !state ? undefined : { egress, tried: [], at };
  if (result !== 'captcha') return state;
  const tried = [...new Set([...fresh(state, now), egress])];
  if (names.every(name => tried.includes(name))) return Object.keys(keep).length ? { ...keep, tried: [], at } : undefined;
  return { ...keep, tried, at };
}

export const vendorEgressPath = (stateDir: string): string => path.join(stateDir, 'computer', 'egress-vendors.json');

export async function readVendorEgress(stateDir: string, id: string): Promise<VendorEgress | undefined> {
  try {
    const value = (JSON.parse(await readFile(vendorEgressPath(stateDir), 'utf8')) as Record<string, unknown>)[id] as Partial<VendorEgress> | undefined;
    if (!value || typeof value !== 'object' || typeof value.at !== 'string') return undefined;
    return { ...(typeof value.egress === 'string' ? { egress: value.egress } : {}), tried: Array.isArray(value.tried) ? value.tried.filter((t): t is string => typeof t === 'string') : [], at: value.at };
  } catch { return undefined; }
}

/** Records a run's result for the vendor; returns the record now kept. */
export async function recordVendorEgress(stateDir: string, id: string, egress: string, result: EgressRunResult, names: readonly string[], now = Date.now()): Promise<VendorEgress | undefined> {
  const before = await readVendorEgress(stateDir, id);
  const next = afterRun(before, egress, result, names, now);
  if (JSON.stringify(next) === JSON.stringify(before)) return next;
  await updateJsonFile(vendorEgressPath(stateDir), objectOrEmpty, current => {
    const all = { ...current };
    if (next) all[id] = next; else delete all[id];
    return all;
  });
  return next;
}
