/** Context auto-tune: where ClikCode compacts each model, learnt per harness and model from what
 * its turns show (turn/context-signals.ts), kept in ~/.clikcode/cache/context-tune.json.
 *
 * The setting (globalSettings.compactAt, `/compact auto|off|<tokens>`): `auto` (the default) uses
 * the level here; a number is that number for every model; `off` leaves compaction to the vendor.
 *
 * A model starts at DEFAULT_COMPACT_AT_TOKENS (or 60% of its window, if lower). Its turns are
 * counted in two groups: those whose context ClikCode had cut below what the vendor's default
 * would have kept (context-shadow.ts), and those that had it all. Once both have enough turns, the
 * cut ones are compared with the whole ones: at the whole-context rate the level steps down; past
 * it the level goes back up to the last level that held. Bounds: the floor (what a compaction
 * leaves plus room to work, turn/vendor-floors.ts) and 60% of the window. Below EVAL_BELOW the
 * graded eval (scripts/compaction-eval.mjs --record) must have passed at that level first.
 * Every change is logged here and in the lifecycle log. */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';
import { quiet } from '../runtime/lifecycle-log.js';
import { COMPACTION_HEADROOM, DEFAULT_COMPACT_AT_TOKENS, MIN_COMPACT_AT_TOKENS, compactSetting } from './compaction.js';
import { addCounts, emptyCounts, type SignalCounts } from './context-signals.js';

/** Turns each group needs before a step is decided. */
export const TUNE_MIN_TURNS = 20;
/** How far one step moves. */
export const TUNE_STEP = 15_000;
/** Below this a level needs the graded eval first. */
export const EVAL_BELOW = 75_000;
/** The highest share of the window a level may be. */
export const CEILING_SHARE = 0.6;
/** Whole-context counts are halved past this many turns, so the rate follows how the model is used now. */
const FULL_KEPT_TURNS = 300;
const KEPT_LOG = 50;

export interface TuneChange { at: string; from: number; to: number; why: string }

export interface ModelTune {
  level: number;
  /** The last level whose cut turns read like whole ones. */
  confirmed?: number;
  /** Signals on turns with all their context, and on cut turns since the last change. */
  full: SignalCounts;
  cut: SignalCounts;
  checkedAt?: string;
  /** The lowest level the graded eval passed at, and when. */
  evalLevel?: number;
  evalAt?: string;
  /** A step down is waiting on the eval. */
  evalWanted?: number;
  log: TuneChange[];
}

interface Kept { v: 1; models: Record<string, ModelTune> }

export interface TuneBounds { floor?: number; window?: number }

const file = (): string => join(stateDirectory(), 'cache', 'context-tune.json');
export const tuneKey = (harness: string, model: string | null | undefined): string => `${harness}\u0000${model ?? ''}`;

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
  } catch { return { v: 1, models: {} }; } // fail-open-ok: no file yet, or a damaged one, is a model not yet tuned
}

async function save(data: Kept): Promise<void> {
  await atomicWriteFile(file(), `${JSON.stringify(data, null, 1)}\n`);
  read = undefined;
}

export function levelBounds(bounds: TuneBounds): { floor: number; ceiling: number } {
  const floor = Math.max(MIN_COMPACT_AT_TOKENS, (bounds.floor ?? 0) + COMPACTION_HEADROOM);
  const ceiling = bounds.window ? Math.max(floor, Math.round(bounds.window * CEILING_SHARE)) : Math.max(floor, DEFAULT_COMPACT_AT_TOKENS);
  return { floor, ceiling };
}

const clamp = (level: number, bounds: TuneBounds): number => {
  const { floor, ceiling } = levelBounds(bounds);
  return Math.min(ceiling, Math.max(floor, level));
};

export function startTune(bounds: TuneBounds): ModelTune {
  return { level: clamp(DEFAULT_COMPACT_AT_TOKENS, bounds), full: emptyCounts(), cut: emptyCounts(), log: [] };
}

/** Per turn: what went wrong (a file read again, a search that found nothing, the user correcting). */
export function lossRate(counts: SignalCounts): number {
  return counts.turns ? (counts.reReads + 2 * counts.hindsightEmpty + 3 * counts.corrections) / counts.turns : 0;
}
export const searchRate = (counts: SignalCounts): number => counts.turns ? counts.hindsight / counts.turns : 0;

/** The step the counts call for, or undefined to keep collecting. Pure. */
export function decideStep(tune: ModelTune, bounds: TuneBounds): { to: number; why: string; evalWanted?: number } | undefined {
  if (tune.full.turns < TUNE_MIN_TURNS || tune.cut.turns < TUNE_MIN_TURNS) return undefined;
  const whole = lossRate(tune.full);
  const cut = lossRate(tune.cut);
  const rates = `loss ${cut.toFixed(2)}/turn cut vs ${whole.toFixed(2)} whole, search ${searchRate(tune.cut).toFixed(2)} vs ${searchRate(tune.full).toFixed(2)}`;
  // Losing more, or searching far less while losing at all more: it no longer has what it needs.
  const worse = cut > whole * 1.25 + 0.05 || (cut > whole && searchRate(tune.cut) < searchRate(tune.full) * 0.5);
  if (worse) {
    const to = clamp(tune.confirmed !== undefined && tune.confirmed > tune.level ? tune.confirmed : tune.level + TUNE_STEP, bounds);
    return { to, why: `up: ${rates}` };
  }
  const down = clamp(tune.level - TUNE_STEP, bounds);
  if (down < EVAL_BELOW && !(tune.evalLevel !== undefined && tune.evalLevel <= down)) {
    return { to: tune.level, why: `holds: ${rates}; ${Math.round(down / 1000)}k needs the graded eval first`, evalWanted: down };
  }
  return { to: down, why: `down: ${rates}` };
}

/** Apply a step: the level, the log, and fresh cut counts for the next comparison. Pure. */
export function applyStep(tune: ModelTune, step: { to: number; why: string; evalWanted?: number }, at: string): TuneChange | undefined {
  tune.checkedAt = at;
  tune.cut = emptyCounts();
  if (step.evalWanted !== undefined) tune.evalWanted = step.evalWanted; else delete tune.evalWanted;
  if (step.to < tune.level) tune.confirmed = tune.level;
  else if (step.to > tune.level && tune.confirmed !== undefined && step.to >= tune.confirmed) delete tune.confirmed;
  if (step.to === tune.level) {
    if (tune.log.at(-1)?.why !== step.why) tune.log.push({ at, from: tune.level, to: tune.level, why: step.why });
    tune.log = tune.log.slice(-KEPT_LOG);
    return undefined;
  }
  const change = { at, from: tune.level, to: step.to, why: step.why };
  tune.level = step.to;
  tune.log = [...tune.log, change].slice(-KEPT_LOG);
  return change;
}

/** The level auto uses for `harness` on `model` now. */
export function tunedLevel(harness: string, model: string | null | undefined, bounds: TuneBounds = {}): number {
  const tune = load().models[tuneKey(harness, model)];
  return tune ? clamp(tune.level, bounds) : startTune(bounds).level;
}

/** The threshold the setting gives this harness and model: undefined for off. */
export function contextThreshold(settings: { compactAt?: unknown } | undefined, harness: string, model: string | null | undefined, bounds: TuneBounds = {}): number | undefined {
  const setting = compactSetting(settings);
  if (setting === 'off') return undefined;
  if (setting === 'auto') return tunedLevel(harness, model, bounds);
  return setting;
}

/** Count one turn's signals; under auto, step when the counts call for it. Returns the change. */
export async function noteTurnSignals(
  harness: string, model: string | null | undefined, counts: SignalCounts, cut: boolean, bounds: TuneBounds, auto: boolean, now: Date = new Date(),
): Promise<TuneChange | undefined> {
  const data = load();
  const key = tuneKey(harness, model);
  const tune = data.models[key] ??= startTune(bounds);
  addCounts(cut ? tune.cut : tune.full, counts);
  if (tune.full.turns > FULL_KEPT_TURNS) {
    for (const name of Object.keys(tune.full) as (keyof SignalCounts)[]) tune.full[name] = Math.floor(tune.full[name] / 2);
  }
  const step = auto ? decideStep(tune, bounds) : undefined;
  const change = step ? applyStep(tune, step, now.toISOString()) : undefined;
  await save(data).catch(quiet('turn/context-tune'));
  return change;
}

/** The graded eval passed (or failed) at `level` for this model. A failure raises the level to the
 * lowest that passed. */
export async function recordTuneEval(harness: string, model: string | null | undefined, level: number, passed: boolean, bounds: TuneBounds = {}, now: Date = new Date()): Promise<ModelTune> {
  const data = load();
  const tune = data.models[tuneKey(harness, model)] ??= startTune(bounds);
  const at = now.toISOString();
  if (passed) {
    if (tune.evalLevel === undefined || level < tune.evalLevel) tune.evalLevel = level;
    tune.evalAt = at;
    tune.log = [...tune.log, { at, from: tune.level, to: tune.level, why: `graded eval passed at ${Math.round(level / 1000)}k` }].slice(-KEPT_LOG);
    if (tune.evalWanted !== undefined && tune.evalWanted >= level) delete tune.evalWanted;
  } else {
    tune.evalAt = at;
    const to = Math.max(tune.level, level + TUNE_STEP);
    tune.log = [...tune.log, { at, from: tune.level, to, why: `graded eval failed at ${Math.round(level / 1000)}k` }].slice(-KEPT_LOG);
    tune.level = clamp(to, bounds);
    if (tune.evalLevel !== undefined && tune.evalLevel <= level) delete tune.evalLevel;
  }
  await save(data);
  return tune;
}

/** Every tuned model, for the report. */
export function tunedModels(): { harness: string; model: string; tune: ModelTune }[] {
  return Object.entries(load().models).map(([key, tune]) => {
    const [harness = '', model = ''] = key.split('\u0000');
    return { harness, model, tune };
  });
}
