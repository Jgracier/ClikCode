/** Watching the machine's memory while a model runs, and deciding what the
 * model gives back when other programs need it.
 *
 * The functions here are pure, and self-contained on purpose: the
 * supervisor (lifecycle.ts) is an inline script with no imports, and it
 * embeds them by their source text (`String(fn)`). So none of them may
 * refer to anything outside its own body -- no module constants, no
 * helpers -- or the embedded copy would fail where the tested one works.
 * A test runs the embedded copies to hold that line.
 *
 * What counts as whose memory. MemAvailable (Linux) counts page cache as
 * available, and that includes the model's own mmapped weights. Those pages
 * are not spare: evicting them makes every token re-read the file from
 * disk, which is thrashing by another name. So
 *   spare  = MemAvailable - the model's resident file pages (RssFile)
 * is what other programs can still take without hurting the model, and
 *   others = total - MemAvailable - the model's RssAnon
 * is what they hold now (for the log and the notice; the decision needs
 * only `spare`). The model's own growth -- its prompt cache filling --
 * lowers MemAvailable too, but it cannot be mistaken for other programs:
 * the buffer is judged on `spare`, and the model's growth is bounded by the
 * budget it was started within. */

export interface MemorySample {
  /** Milliseconds, any monotonic-enough clock. */
  at: number;
  totalBytes: number;
  availableBytes: number;
  /** Cumulative pages swapped out (Linux pswpout, macOS Swapouts). */
  swapOutPages?: number;
  ourAnonBytes: number;
  ourFileBytes: number;
}

/** One way to give memory back without stopping: a restart at a smaller
 * context and without the prompt cache. `freesBytes` is what it would
 * free relative to what runs now. */
export interface ShrinkOption {
  context: number;
  freesBytes: number;
}

export interface WatchState {
  /** When spare memory first fell below the buffer, this spell. */
  lowSince?: number;
  /** When the last shrink or stop was decided (or, for a restart, when
   * the restarted server answered again). */
  lastActionAt?: number;
  lastSwapOut?: number;
  lastAt?: number;
}

export type WatchLevel = 'ok' | 'low' | 'critical';
export type WatchAction = 'none' | 'wait' | 'shrink' | 'stop';

export interface WatchInput {
  sample: MemorySample;
  state: WatchState;
  bufferBytes: number;
  /** A request is being processed; a restart or stop would cut it off. */
  busy: boolean;
  /** Least drastic first. */
  shrinks: readonly ShrinkOption[];
}

export interface WatchDecision {
  state: WatchState;
  level: WatchLevel;
  action: WatchAction;
  spareBytes: number;
  othersBytes: number;
  swapOutPerSecond: number;
  shrinkIndex?: number;
  reason?: string;
}

/** One sample in, one decision out.
 *
 * Thresholds, with a 2 s sampling interval:
 *  - low: spare under the buffer. Acted on after 15 s: a compile step or a
 *    page-cache refill dips for a few seconds and recovers; 15 s of deficit
 *    is a workload that is staying.
 *  - critical: spare under half the buffer, or the kernel swapping out at
 *    1 MiB/s or more while under it. Acted on after 4 s (two samples, so
 *    one odd reading is not enough) -- by then the machine is about to
 *    swap, or already does. Swap-out alone, with spare above the buffer, is
 *    not pressure: kernels page out cold memory on idle machines too.
 *    Swap-in never is: it is old pages coming back.
 *  - A running request defers a restart or stop while merely low, for up
 *    to 60 s, so a turn is not cut off for a deficit that can wait; when
 *    critical nothing waits.
 *  - After an action, 20 s to settle before the next (only a machine that
 *    is actively swapping cuts that short), so one restart is judged on
 *    what it freed before the next step.
 *  - The first shrink that frees the deficit plus a quarter of the buffer
 *    is taken (the margin keeps it from landing right on the line and
 *    tripping again); if none does, the model stops: it must never be the
 *    reason the machine swaps. */
export function memoryStep(input: WatchInput): WatchDecision {
  const SUSTAIN_MS = 15_000;
  const CRITICAL_MS = 4_000;
  const SETTLE_MS = 20_000;
  const BUSY_GRACE_MS = 60_000;
  const SWAP_OUT_PAGES_PER_SECOND = 256;
  const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

  const sample = input.sample;
  const previous = input.state;
  const spareBytes = sample.availableBytes - sample.ourFileBytes;
  const othersBytes = Math.max(0, sample.totalBytes - sample.availableBytes - sample.ourAnonBytes);
  let swapOutPerSecond = 0;
  if (typeof sample.swapOutPages === 'number' && typeof previous.lastSwapOut === 'number'
    && typeof previous.lastAt === 'number' && sample.at > previous.lastAt) {
    swapOutPerSecond = Math.max(0, sample.swapOutPages - previous.lastSwapOut) / ((sample.at - previous.lastAt) / 1000);
  }
  const state: WatchState = { lastAt: sample.at };
  if (typeof sample.swapOutPages === 'number') state.lastSwapOut = sample.swapOutPages;
  if (previous.lastActionAt !== undefined) state.lastActionAt = previous.lastActionAt;
  const base = { state, spareBytes, othersBytes, swapOutPerSecond };

  const deficit = input.bufferBytes - spareBytes;
  if (deficit <= 0) return { ...base, level: 'ok', action: 'none' };

  const swapping = swapOutPerSecond >= SWAP_OUT_PAGES_PER_SECOND;
  const critical = spareBytes < input.bufferBytes / 2 || swapping;
  const level: WatchLevel = critical ? 'critical' : 'low';
  state.lowSince = previous.lowSince ?? sample.at;
  const lowFor = sample.at - state.lowSince;
  const settling = previous.lastActionAt !== undefined && sample.at - previous.lastActionAt < SETTLE_MS;
  if (settling && !swapping) return { ...base, level, action: 'none' };
  if (lowFor < (critical ? CRITICAL_MS : SUSTAIN_MS)) return { ...base, level, action: 'none' };
  if (!critical && input.busy && lowFor < BUSY_GRACE_MS) {
    return { ...base, level, action: 'wait', reason: 'a request is running' };
  }

  // Worded by what is left, not by who took it: the model's own prompt
  // cache filling lowers spare memory too, and the buffer is defended all
  // the same.
  const why = `only ${gb(Math.max(0, spareBytes))} was left for other programs, under the ${gb(input.bufferBytes)} kept for them`
    + ` (they hold ${gb(othersBytes)}${swapping ? ', and the machine is swapping' : ''})`;
  const wanted = deficit + input.bufferBytes / 4;
  state.lastActionAt = sample.at;
  delete state.lowSince;
  for (let index = 0; index < input.shrinks.length; index++) {
    const option = input.shrinks[index]!;
    if (option.freesBytes >= wanted) {
      return {
        ...base, level, action: 'shrink', shrinkIndex: index,
        reason: `${why}; restarting at ${Math.round(option.context / 1024)}K context without the prompt cache frees about ${gb(option.freesBytes)}`,
      };
    }
  }
  return { ...base, level, action: 'stop', reason: `${why}; no smaller setting of this model frees the ${gb(wanted)} needed` };
}

// ---- readers: OS reports in, numbers out -----------------------------------

/** /proc/meminfo (kB, meaning KiB). Before MemAvailable existed (kernel
 * 3.14) free plus page cache was the kernel's own estimate. */
export function parseMeminfo(text: string): { totalBytes?: number; availableBytes?: number } {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const free = field('MemFree');
  const cached = field('Cached');
  const available = field('MemAvailable') ?? (free !== undefined && cached !== undefined ? free + cached + (field('Buffers') ?? 0) : undefined);
  const total = field('MemTotal');
  return { ...(total !== undefined ? { totalBytes: total } : {}), ...(available !== undefined ? { availableBytes: available } : {}) };
}

/** /proc/vmstat: the cumulative swap-out page count. */
export function parseVmstatSwapOut(text: string): number | undefined {
  const match = /^pswpout\s+(\d+)/m.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** /proc/<pid>/status: resident anonymous memory (the process's own
 * allocations: repacked weights, KV cache, prompt cache, buffers) and
 * resident file pages (the mmapped weights). */
export function parseProcStatus(text: string): { anonBytes: number; fileBytes: number } {
  const field = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : 0;
  };
  return { anonBytes: field('RssAnon'), fileBytes: field('RssFile') };
}

/** macOS `vm_stat`: available is free, inactive, speculative and
 * purgeable pages (what Activity Monitor counts), plus the swap-out
 * counter. Page size is in the header. */
export function parseVmStatMac(text: string): { availableBytes?: number; swapOutPages?: number } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  const swapouts = /^Swapouts:\s+(\d+)/m.exec(text);
  return { ...(total > 0 ? { availableBytes: total * pageSize } : {}), ...(swapouts ? { swapOutPages: Number(swapouts[1]) } : {}) };
}

/** A model's peak footprint as measured, merged into what was measured
 * before under the same key: peaks only grow (a longer conversation fills
 * more of the prompt cache), so the larger of old and new is kept. */
export interface FootprintRecord {
  context: number;
  cacheType: string;
  parallel: number;
  vision: boolean;
  anonBytes: number;
  fileBytes: number;
  at: string;
}

export function mergeFootprint(previous: FootprintRecord | undefined, next: FootprintRecord): FootprintRecord {
  if (!previous) return next;
  return { ...next, anonBytes: Math.max(previous.anonBytes, next.anonBytes), fileBytes: Math.max(previous.fileBytes, next.fileBytes) };
}
