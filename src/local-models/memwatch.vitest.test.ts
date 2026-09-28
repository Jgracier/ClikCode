import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { SUPERVISOR_SCRIPT } from './lifecycle';
import {
  memoryStep, mergeFootprint, parseMeminfo, parseMemoryPressure, parseProcStatus, parseVmStatMac, parseVmstatSwapOut,
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

  it('acts on a deficit sustained for 6 s: the least drastic shrink that covers it', () => {
    // Spare 5 GB, buffer 5.76: deficit 0.76 GB, wanted 0.76 + 1.44 = 2.2 GB.
    const decisions = run(Array(10).fill(7 * GB), { shrinks: SHRINKS });
    const first = decisions.findIndex((decision) => decision.action !== 'none');
    expect(first).toBe(3); // t = 6 s
    expect(decisions[first]).toMatchObject({ action: 'shrink', shrinkIndex: 2, level: 'low' });
    expect(decisions[first]!.reason).toMatch(/only 5\.0 GB was left for other programs, under the 5\.8 GB buffer.*16K context/);
  });

  it('stops when no shrink frees enough', () => {
    const decisions = run(Array(10).fill(7 * GB), { shrinks: [{ context: 32_768, freesBytes: 1 * GB }] });
    expect(decisions[3]).toMatchObject({ action: 'stop' });
    expect(decisions[3]!.reason).toMatch(/no smaller setting of this model frees/);
  });

  it('acts within 2 s when critical: under half the buffer', () => {
    const decisions = run([2 * GB, 2 * GB, 2 * GB, 2 * GB], { shrinks: SHRINKS });
    expect(decisions.map((decision) => decision.level)).toEqual(['critical', 'critical', 'critical', 'critical']);
    // Deficit 5.76 GB: no shrink covers it.
    expect(decisions.slice(0, 2).map((decision) => decision.action)).toEqual(['none', 'stop']);
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
    expect(step(4000, 7 * GB, 11_000)).toMatchObject({ level: 'critical', swapOutPerSecond: 2500, action: 'stop' });
  });

  it('backs off on swap-out just above the buffer', () => {
    const first = memoryStep({ sample: sample(0, 8.2 * GB, { swapOutPages: 1000 }), state: {}, bufferBytes: BUFFER, busy: true, shrinks: [] });
    const second = memoryStep({ sample: sample(2000, 8.2 * GB, { swapOutPages: 6000 }), state: first.state,
      bufferBytes: BUFFER, busy: true, shrinks: [] });
    expect(first).toMatchObject({ level: 'ok', action: 'none' });
    expect(second).toMatchObject({ level: 'critical', action: 'stop' });
    expect(second.reason).toMatch(/swapping out/);
  });

  it('defers while a request runs if merely low, but not past 12 s', () => {
    const decisions = run(Array(32).fill(7 * GB), { shrinks: SHRINKS, busy: true });
    expect(decisions[3]!.action).toBe('wait');
    expect(decisions[5]!.action).toBe('wait');
    expect(decisions[6]!.action).toBe('shrink'); // t = 12 s
  });

  it('does not defer when critical', () => {
    const decisions = run([2 * GB, 2 * GB, 2 * GB], { busy: true });
    expect(decisions[1]!.action).toBe('stop');
  });

  it('backs off on sustained Linux memory stalls before the RAM buffer is crossed', () => {
    const pressured = run([8 * GB, 8 * GB], {
      shrinks: [{ context: 16_384, freesBytes: 5 * GB }],
    });
    expect(pressured.every((decision) => decision.level === 'ok')).toBe(true);
    let state: WatchState = {};
    const decisions = [0, 2000].map((at) => {
      const decision = memoryStep({ sample: sample(at, 8 * GB, { pressureSomeAvg10: 1.44 }), state,
        bufferBytes: BUFFER, busy: true, shrinks: [{ context: 16_384, freesBytes: 5 * GB }] });
      state = decision.state;
      return decision;
    });
    expect(decisions[0]).toMatchObject({ level: 'critical', action: 'none' });
    expect(decisions[1]).toMatchObject({ level: 'critical', action: 'shrink' });
    const roomy = memoryStep({ sample: sample(4000, 20 * GB, { pressureSomeAvg10: 1.44 }), state: {},
      bufferBytes: BUFFER, busy: false, shrinks: [] });
    expect(roomy).toMatchObject({ level: 'ok', action: 'none' });
  });

  it('acts on critical pressure even during the post-shrink settling window', () => {
    const decisions = run([2 * GB, 2 * GB], {}, { lastActionAt: 0 });
    expect(decisions[1]!.action).toBe('stop');
  });

  it('lets an action settle for 10 s before the next, unless pressure is critical', () => {
    const decisions = run(Array(30).fill(7 * GB), { shrinks: SHRINKS });
    const actions = decisions.map((decision, index) => [index, decision.action] as const).filter(([, action]) => action !== 'none');
    expect(actions[0]).toEqual([3, 'shrink']);
    expect(actions[1]![0] * 2000).toBeGreaterThanOrEqual(16_000);
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

  it('reads Linux memory pressure', () => {
    expect(parseMemoryPressure('some avg10=1.44 avg60=0.24 avg300=0.05 total=123\nfull avg10=0.00\n')).toBe(1.44);
    expect(parseMemoryPressure('')).toBeUndefined();
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
    const first = { context: 1, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 5, fileBytes: 9, mmap: true, at: 'a' };
    expect(mergeFootprint(first, { ...first, anonBytes: 7, fileBytes: 3, at: 'b' })).toMatchObject({ anonBytes: 7, fileBytes: 9, at: 'b' });
    expect(mergeFootprint(undefined, first)).toBe(first);
  });

  it('replaces, not merges, a record made with the other loading mode', () => {
    // A mapped run's 15.2 GB anonymous peak must not survive into a read-in record.
    const mapped = { context: 1, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 15.2e9, fileBytes: 20.5e9, mmap: true, at: 'a' };
    const read = { ...mapped, anonBytes: 12e9, fileBytes: 0, mmap: false, at: 'b' };
    expect(mergeFootprint(mapped, read)).toEqual(read);
    // Records from before the field existed are mapped runs.
    const { mmap: _dropped, ...legacy } = mapped;
    expect(mergeFootprint(legacy as typeof mapped, read)).toEqual(read);
  });

  it('counts a read-in server\'s whole footprint as its own, and spare as all of MemAvailable', () => {
    // With the weights read in, the supervisor passes ourFileBytes 0.
    const decision = memoryStep({ sample: { ...sample(0, 7 * GB), ourAnonBytes: 24 * GB, ourFileBytes: 0 }, state: {}, bufferBytes: BUFFER, busy: false, shrinks: [] });
    expect(decision.spareBytes).toBe(7 * GB);
    expect(decision.level).toBe('ok');
    expect(decision.othersBytes).toBe(29 * GB);
  });
});

describe('the supervisor\'s embedded copies', () => {
  it('compiles', () => {
    expect(() => new Script(SUPERVISOR_SCRIPT)).not.toThrow();
  });

  it('decides as the module does: nothing outside their bodies is referenced', () => {
    // Evaluated alone, as the supervisor does, with no module scope around them.
    const embedded = new Function(`${SUPERVISOR_SCRIPT.slice(SUPERVISOR_SCRIPT.indexOf('const memoryStep'), SUPERVISOR_SCRIPT.indexOf('const config'))}
      return { memoryStep, parseMeminfo, parseMemoryPressure, parseProcStatus, parseVmstatSwapOut, parseVmStatMac, mergeFootprint };`)() as {
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
    expect(embedded.parseMemoryPressure('some avg10=1.44 avg60=0.24')).toBe(1.44);
    expect(embedded.parseProcStatus('RssAnon:\t1 kB\nRssFile:\t2 kB\n')).toEqual({ anonBytes: 1024, fileBytes: 2048 });
  });
});
