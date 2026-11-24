/** What a vendor's own compaction was measured to leave, and the largest growth one model call
 * made, kept per harness and model on disk across conversations and accounts
 * (turn/compaction.ts vendorTrigger). A conversation's first launch is set from these instead
 * of a fixed estimate, and a new chat, account or model switch starts from a measured number.
 * The highest of the most recent conversations' readings: a floor depends on what a chat
 * carries (its files, instructions and tools), and an old outlier ages out. */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';
import { quiet } from '../runtime/lifecycle-log.js';
import type { VendorMeasures } from './compaction.js';

export type { VendorMeasures };

/** The conversations each harness and model keeps readings for. */
const KEPT_CONVERSATIONS = 8;

interface Reading { floor?: number; step?: number; at: string }
interface Kept { v: 1; models: Record<string, Record<string, Reading>> }


const file = (): string => join(stateDirectory(), 'cache', 'vendor-floors.json');
const keyOf = (harness: string, model: string | null | undefined): string => `${harness}\u0000${model ?? ''}`;

let read: { path: string; mtime: number; data: Kept } | undefined;

function load(): Kept {
  const path = file();
  try {
    const mtime = statSync(path).mtimeMs;
    if (read?.path === path && read.mtime === mtime) return read.data;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Kept;
    const data: Kept = parsed?.v === 1 && parsed.models && typeof parsed.models === 'object' ? parsed : { v: 1, models: {} };
    read = { path, mtime, data };
    return data;
  } catch { return { v: 1, models: {} }; } // fail-open-ok: no file yet, or a damaged one, is nothing measured
}

function highest(readings: Iterable<Reading>): VendorMeasures {
  const out: VendorMeasures = {};
  for (const reading of readings) {
    if (reading.floor !== undefined) out.floor = Math.max(out.floor ?? 0, reading.floor);
    if (reading.step !== undefined) out.step = Math.max(out.step ?? 0, reading.step);
  }
  return out;
}

/** The measured floor and step for `harness` on `model`; on a model never measured, the
 * harness's on any model (its floor is mostly its own prompt, tools and restored files). */
export function knownVendorMeasures(harness: string, model: string | null | undefined): VendorMeasures {
  const models = load().models;
  const own = models[keyOf(harness, model)];
  if (own) return highest(Object.values(own));
  const prefix = `${harness}\u0000`;
  return highest(Object.entries(models).filter(([key]) => key.startsWith(prefix)).flatMap(([, chats]) => Object.values(chats)));
}

let writing: Promise<void> = Promise.resolve();

/** Keeps a conversation's reading where it is higher than what it had. */
export function rememberVendorMeasure(
  harness: string, model: string | null | undefined, conversation: string, measure: VendorMeasures,
): Promise<void> {
  const kept = load().models[keyOf(harness, model)]?.[conversation];
  const higher = (name: keyof VendorMeasures) => measure[name] !== undefined && measure[name]! > (kept?.[name] ?? 0);
  if (!higher('floor') && !higher('step')) return writing;
  writing = writing.then(async () => {
    const data = load();
    const key = keyOf(harness, model);
    const chats = { ...data.models[key] };
    const before = chats[conversation];
    const next: Reading = { ...before, at: new Date().toISOString() };
    for (const name of ['floor', 'step'] as const) {
      if (measure[name] !== undefined) next[name] = Math.max(before?.[name] ?? 0, measure[name]!);
    }
    chats[conversation] = next;
    const recent = Object.entries(chats).sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at)).slice(0, KEPT_CONVERSATIONS);
    const written: Kept = { v: 1, models: { ...data.models, [key]: Object.fromEntries(recent) } };
    await atomicWriteFile(file(), `${JSON.stringify(written)}\n`);
    read = undefined;
  }).catch(quiet('turn/vendor-floors'));
  return writing;
}
