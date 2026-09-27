import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { SUPERVISOR_SCRIPT } from './lifecycle';
import {
  memoryStep, mergeFootprint, parseMeminfo, parseProcStatus, parseVmStatMac, parseVmstatSwapOut,
  type MemorySample, type ShrinkOption, type WatchDecision, type WatchInput, type WatchState,
} from './memwatch';

const GB = 1e9;
const BUFFER = 5.76 * GB;
const TOTAL = 60 * GB;

/** A model holding 4 GB of its own and 2 GB of cached weights. */
function sample(at: number, availableBytes: number, extra: Partial<MemorySample> = {}): MemorySample {
  return { at, totalBytes: TOTAL, availableBytes, ourAnonBytes: 4 * GB, ourFileBytes: 2 * GB, ...extra };
}

/** Feed samples every 2 s from t=0, returning each decision. */
function run(availables: number[], options: Partial<Omit<WatchInput, 'sample' | 'state'>> = {}, start: WatchState = {}): WatchDecision[] {
  let state = start;
  return availables.map((available, index) => {
    const decision = memoryStep({ sample: sample(index * 2000, available), state, bufferBytes: BUFFER, busy: false, shrinks: [], ...options });
    state = decision.state;
    return decision;
  });
}

const SHRINKS: ShrinkOption[] = [{ context: 65_536, freesBytes: 0.5 * GB }, { context: 32_768, freesBytes: 2 * GB }, { context: 16_384, freesBytes: 3 * GB }];

describe('memory decisions', () => {
  it('counts the model\'s cached weights as the model\'s, not spare', () => {
    const [decision] = run([7 * GB]);
    // 7 GB available, 2 GB of it the model's weights: 5 GB spare, under the buffer.
    expect(decision!.spareBytes).toBe(5 * GB);
    expect(decision!.level).toBe('low');
    // Others: 60 - 7 available - 4 of the model's own.
    expect(decision!.othersBytes).toBe(49 * GB);
  });

  it('does nothing while spare memory stays above the buffer', () => {
    expect(run(Array(20).fill(20 * GB)).every((decision) => decision.level === 'ok' && decision.action === 'none')).toBe(true);
  });

  it('ignores a blip below the buffer', () => {
    const decisions = run([20 * GB, 7 * GB, 7 * GB, 7 * GB, 20 * GB, 20 * GB], { shrinks: SHRINKS });
    expect(decisions.map((decision) => decision.action)).toEqual(Array(6).fill('none'));
    expect(decisions.at(-1)!.state.lowSince).toBeUndefined();
  });

  it('acts on a deficit sustained for 15 s: the least drastic shrink that covers it', () => {
    // Spare 5 GB, buffer 5.76: deficit 0.76 GB, wanted 0.76 + 1.44 = 2.2 GB.
    const decisions = run(Array(10).fill(7 * GB), { shrinks: SHRINKS });
    const first = decisions.findIndex((decision) => decision.action !== 'none');
    expect(first).toBe(8); // t = 16 s, the first sample 15 s past the first low one
    expect(decisions[first]).toMatchObject({ action: 'shrink', shrinkIndex: 2, level: 'low' });
    expect(decisions[first]!.reason).toMatch(/only 5\.0 GB was left for other programs, under the 5\.8 GB kept for them.*16K context/);
  });

  it('stops when no shrink frees enough', () => {
    const decisions = run(Array(10).fill(7 * GB), { shrinks: [{ context: 32_768, freesBytes: 1 * GB }] });
    expect(decisions[8]).toMatchObject({ action: 'stop' });
    expect(decisions[8]!.reason).toMatch(/no smaller setting of this model frees/);
  });

  it('acts within 4 s when critical: under half the buffer', () => {
    const decisions = run([2 * GB, 2 * GB, 2 * GB, 2 * GB], { shrinks: SHRINKS });
    expect(decisions.map((decision) => decision.level)).toEqual(['critical', 'critical', 'critical', 'critical']);
    // Deficit 5.76 GB: no shrink covers it.
    expect(decisions.map((decision) => decision.action)).toEqual(['none', 'none', 'stop', 'none']);
  });

  it('treats swapping out while under the buffer as critical, and swap-out alone as nothing', () => {
    let state: WatchState = {};
    const step = (at: number, available: number, swapOutPages: number): WatchDecision => {
      const decision = memoryStep({ sample: sample(at, available, { swapOutPages }), state, bufferBytes: BUFFER, busy: false, shrinks: [] });
      state = decision.state;
      return decision;
    };
    step(0, 20 * GB, 1000);
    // 5000 pages in 2 s with plenty spare: the kernel paging out cold memory.
    expect(step(2000, 20 * GB, 6000).level).toBe('ok');
    expect(step(4000, 7 * GB, 11_000)).toMatchObject({ level: 'critical', swapOutPerSecond: 2500 });
    expect(step(6000, 7 * GB, 16_000).action).toBe('none');
    expect(step(8000, 7 * GB, 21_000).action).toBe('stop');
  });

  it('defers while a request runs if merely low, but not past 60 s', () => {
    const decisions = run(Array(32).fill(7 * GB), { shrinks: SHRINKS, busy: true });
    expect(decisions[8]!.action).toBe('wait');
    expect(decisions[29]!.action).toBe('wait');
    expect(decisions[30]!.action).toBe('shrink'); // t = 60 s
  });

  it('does not defer when critical', () => {
    const decisions = run([2 * GB, 2 * GB, 2 * GB], { busy: true });
    expect(decisions[2]!.action).toBe('stop');
  });

  it('lets an action settle for 20 s before the next, unless the machine swaps', () => {
    const decisions = run(Array(30).fill(7 * GB), { shrinks: SHRINKS });
    const actions = decisions.map((decision, index) => [index, decision.action] as const).filter(([, action]) => action !== 'none');
    // Shrink at t=16 s; the spell restarts after the settle, so the next
    // action is 15 s past the end of it (t=16+20=36 s at the earliest).
    expect(actions[0]).toEqual([8, 'shrink']);
    expect(actions[1]![0] * 2000).toBeGreaterThanOrEqual(36_000);
  });
});

describe('memory readers', () => {
  it('reads MemAvailable, or free plus cache on old kernels', () => {
    expect(parseMeminfo('MemTotal:       60435252 kB\nMemFree:  1000 kB\nMemAvailable:   38092064 kB\nCached: 5 kB\n'))
      .toEqual({ totalBytes: 60435252 * 1024, availableBytes: 38092064 * 1024 });
    expect(parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 1 kB\nCached: 20 kB\n')).toEqual({ totalBytes: 102400, availableBytes: 31 * 1024 });
  });

  it('reads the swap-out counter', () => {
    expect(parseVmstatSwapOut('pswpin 134386157\npswpout 227903104\n')).toBe(227903104);
    expect(parseVmstatSwapOut('nr_free_pages 1\n')).toBeUndefined();
  });

  it('reads a process\'s anonymous and file-backed resident memory', () => {
    const status = 'Name:\tllama-server\nVmRSS:\t22647840 kB\nRssAnon:\t11819244 kB\nRssFile:\t10828596 kB\nRssShmem:\t       0 kB\n';
    expect(parseProcStatus(status)).toEqual({ anonBytes: 11819244 * 1024, fileBytes: 10828596 * 1024 });
    expect(parseProcStatus('')).toEqual({ anonBytes: 0, fileBytes: 0 });
  });

  it('reads macOS vm_stat', () => {
    const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100.\nPages inactive: 50.\nPages speculative: 10.\nPages purgeable: 0.\nSwapouts:  42.\n';
    expect(parseVmStatMac(text)).toEqual({ availableBytes: 160 * 16384, swapOutPages: 42 });
  });

  it('keeps the larger peak of two runs', () => {
    const first = { context: 1, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 5, fileBytes: 9, at: 'a' };
    expect(mergeFootprint(first, { ...first, anonBytes: 7, fileBytes: 3, at: 'b' })).toMatchObject({ anonBytes: 7, fileBytes: 9, at: 'b' });
    expect(mergeFootprint(undefined, first)).toBe(first);
  });
});

describe('the supervisor\'s embedded copies', () => {
  it('compiles', () => {
    expect(() => new Script(SUPERVISOR_SCRIPT)).not.toThrow();
  });

  it('decides as the module does: nothing outside their bodies is referenced', () => {
    // Evaluated alone, as the supervisor does, with no module scope around them.
    const embedded = new Function(`${SUPERVISOR_SCRIPT.slice(SUPERVISOR_SCRIPT.indexOf('const memoryStep'), SUPERVISOR_SCRIPT.indexOf('const config'))}
      return { memoryStep, parseMeminfo, parseProcStatus, parseVmstatSwapOut, parseVmStatMac, mergeFootprint };`)() as {
      memoryStep: typeof memoryStep; parseMeminfo: typeof parseMeminfo; parseProcStatus: typeof parseProcStatus;
    };
    let state: WatchState = {};
    let last: WatchDecision | undefined;
    for (let index = 0; index < 10; index++) {
      last = embedded.memoryStep({ sample: sample(index * 2000, 7 * GB), state, bufferBytes: BUFFER, busy: false, shrinks: SHRINKS });
      state = last.state;
      if (last.action !== 'none') break;
    }
    expect(last).toMatchObject({ action: 'shrink', shrinkIndex: 2 });
    expect(embedded.parseMeminfo('MemTotal: 2 kB\nMemAvailable: 1 kB\n')).toEqual({ totalBytes: 2048, availableBytes: 1024 });
    expect(embedded.parseProcStatus('RssAnon:\t1 kB\nRssFile:\t2 kB\n')).toEqual({ anonBytes: 1024, fileBytes: 2048 });
  });
});
