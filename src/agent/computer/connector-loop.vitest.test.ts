import { describe, expect, it } from 'vitest';
import { BudgetError, budgeted, CallBudget, Cooldown, DEFAULT_LIMITS, parsePressure, runLoop, stalledBy, tabName, wallOf, type LoopLimits, type LoopPorts, type LoopReport, type LoopState, type WorkContext } from './connector-loop.js';
import { claimable } from './connector-loop-live.js';
import type { DeployClient, VendorOutcome } from './connector-runner.js';

const limits = (over: Partial<LoopLimits> = {}): LoopLimits => ({ ...DEFAULT_LIMITS, parallel: 2, maxMs: 300, graceMs: 60, tickMs: 4, idleMs: 4, renewMs: 25, pauseBaseMs: 10, pauseMaxMs: 40, maxHoursMs: 120, cooldownMs: 60_000, wallCooldownMs: 120_000, ...over });
const outcome = (id: string, over: Partial<VendorOutcome> = {}): VendorOutcome => ({ id, status: 'published', steps: 3, browserActions: 2, stage: 'connect', summary: 'done', actions: [], ...over });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A fake queue and fakes for everything the loop touches. `queue` is what ClikDeploy would hand out, in order. */
function fakes(queue: string[], work: (id: string, ctx: WorkContext) => Promise<VendorOutcome>, over: Partial<LoopPorts> = {}) {
  const log: string[] = [], reports: Array<[string, LoopReport]> = [], renewed: string[] = [], closed: string[] = [], excludes: string[][] = [], states: LoopState[] = [];
  let restarts = 0;
  const ports: LoopPorts = {
    now: Date.now, sleep: wait, log: l => log.push(l), pid: 1,
    async next(n, exclude) { excludes.push([...exclude]); const out: Array<{ id: string }> = []; while (out.length < n) { const i = queue.findIndex(id => !exclude.has(id)); if (i < 0) break; out.push({ id: queue.splice(i, 1)[0]! }); } return out; },
    renew: async id => { renewed.push(id); },
    work,
    report: async (id, r) => { reports.push([id, r]); },
    pressure: async () => ({ stalled: false }),
    closeTab: async id => { closed.push(id); },
    restartBrowser: async () => { restarts++; },
    saveState: async s => { states.push(s); },
    ...over,
  };
  return { ports, log, reports, renewed, closed, excludes, states, restarts: () => restarts };
}

describe('budget', () => {
  it('counts every ClikDeploy call and refuses the one past the budget', async () => {
    const client = { waiting: async () => [], batch: async () => ({ results: [], skipped: [] }), onboard: async () => ({}) as never, report: async () => undefined, note: async () => undefined, tool: async () => ({}) } as DeployClient;
    const budget = new CallBudget(3);
    const c = budgeted(client, budget);
    await c.onboard('a'); await c.tool('x', {}); await c.note('a', 't');
    await expect(c.report({ id: 'a', outcome: 'retry', reason: 'later please' })).rejects.toBeInstanceOf(BudgetError);
    expect(budget.used).toBe(3);
  });

  it('a vendor that runs out of calls is reported as a budget stop (retry), counted as the budget wall, and given the cooldown', async () => {
    const f = fakes(['a'], async (id, ctx) => { for (;;) ctx.budget.spend(); void id; });
    const sum = await runLoop(f.ports, limits({ maxCalls: 5 }));
    expect(sum.walls).toEqual({ budget: 1 });
    expect(f.reports[0]![1]).toMatchObject({ outcome: 'retry' });
    expect(f.reports[0]![1].reason).toContain('wall:budget');
    expect(f.log.join('\n')).toMatch(/id=a outcome=budget wall=budget calls=5/);
  });

  it('a vendor past its hard time limit is cut off: tab closed, browser restarted, reported as a budget stop', async () => {
    const f = fakes(['slow'], () => new Promise<VendorOutcome>(() => undefined));
    const sum = await runLoop(f.ports, limits({ maxMs: 30, graceMs: 20, maxHoursMs: 200 }));
    expect(sum.walls.budget).toBe(1);
    expect(f.closed).toContain('slow');
    expect(f.restarts()).toBe(1);
    expect(f.reports[0]![1].outcome).toBe('retry');
  });
});

describe('tabs', () => {
  it('names a separate tab per vendor, never the default tab, and works at most --parallel at once', async () => {
    let live = 0, peak = 0;
    const tabs: string[] = [];
    const f = fakes(['a', 'b', 'c', 'd'], async (id, ctx) => { tabs.push(ctx.tab); live++; peak = Math.max(peak, live); await wait(15); live--; return outcome(id); });
    await runLoop(f.ports, limits({ parallel: 2, maxHoursMs: 100 }));
    expect(tabs.sort()).toEqual(['loop-a', 'loop-b', 'loop-c', 'loop-d']);
    expect(tabs).not.toContain('connectors');
    expect(peak).toBe(2);
    expect(tabName('Weird_ID.x')).toBe('loop-weird-id-x');
  });
});

describe('cooldown', () => {
  it('does not take the same vendor twice within the cooldown, and offers it to the queue as excluded', async () => {
    const worked: string[] = [];
    const queue = ['a'];
    const f = fakes(queue, async id => { worked.push(id); queue.push('a'); return outcome(id); });
    await runLoop(f.ports, limits({ maxHoursMs: 80 }));
    expect(worked).toEqual(['a']);
    expect(f.excludes.some(e => e.includes('a'))).toBe(true);
  });

  it('takes it again once the cooldown has passed', async () => {
    const worked: string[] = [];
    const queue = ['a'];
    const f = fakes(queue, async id => { worked.push(id); queue.push('a'); return outcome(id); });
    await runLoop(f.ports, limits({ maxHoursMs: 150, cooldownMs: 20 }));
    expect(worked.length).toBeGreaterThan(1);
  });

  it('a wall holds longer than a budget stop, and a restarted loop keeps the cooldown it saved', () => {
    let t = 1000;
    const c = new Cooldown(10, () => t);
    c.mark('a'); c.mark('b', 100);
    t += 50;
    expect(c.active('a')).toBe(false);
    expect(c.active('b')).toBe(true);
    const again = new Cooldown(10, () => t);
    again.restore(c.snapshot());
    expect(again.ids()).toEqual(['b']);
  });
});

describe('backoff when the machine stalls', () => {
  it('reads io and cpu full-stall and pauses above 10 percent', () => {
    expect(parsePressure('some avg10=3.20 avg60=1.00 avg300=0.50 total=1\nfull avg10=12.50 avg60=4.00 avg300=1.00 total=2')).toEqual({ some: 3.2, full: 12.5 });
    expect(stalledBy('some avg10=0 \nfull avg10=11.0 avg60=0', 'some avg10=1.0')).toMatchObject({ stalled: true, io: 11 });
    expect(stalledBy('full avg10=2.0', 'full avg10=0.00')).toMatchObject({ stalled: false });
    expect(stalledBy('full avg10=10.00', undefined).stalled).toBe(false);
    expect(stalledBy(undefined, undefined).stalled).toBe(false);
  });

  it('starts no new vendor while stalled, waits longer each time, and carries on when it clears', async () => {
    let reads = 0;
    const takes: number[] = [];
    const started = Date.now();
    const f = fakes(['a'], async id => outcome(id), {
      pressure: async () => ({ stalled: ++reads <= 3, io: 40 }),
      next: async () => { takes.push(Date.now() - started); return takes.length === 1 ? [{ id: 'a' }] : []; },
    });
    const sum = await runLoop(f.ports, limits({ maxHoursMs: 200, pauseBaseMs: 10, pauseMaxMs: 40 }));
    expect(sum.pauses).toBe(3);
    expect(takes[0]).toBeGreaterThanOrEqual(10 + 20);
    expect(sum.vendors).toBe(1);
    expect(f.log.filter(l => l.includes('machine stalled'))).toHaveLength(3);
  });
});

describe('lease renewal', () => {
  it('renews the lease of a vendor that works longer than the renewal period, repeatedly, and only while it works', async () => {
    const f = fakes(['a'], async id => { await wait(90); return outcome(id); });
    const sum = await runLoop(f.ports, limits({ renewMs: 20, maxHoursMs: 60 }));
    expect(f.renewed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(f.renewed)).toEqual(new Set(['a']));
    expect(sum.renewals).toBe(f.renewed.length);
    const after = f.renewed.length;
    await wait(40);
    expect(f.renewed.length).toBe(after);
  });
});

describe('hung browser', () => {
  it('restarts the browser and resumes the vendor once when the browser went away, then reports its outcome', async () => {
    let tries = 0;
    const f = fakes(['a'], async id => { if (++tries === 1) throw new Error('browserContext.newPage: Target page, context or browser has been closed'); return outcome(id); });
    const sum = await runLoop(f.ports, limits());
    expect(tries).toBe(2);
    expect(f.restarts()).toBe(1);
    expect(sum.restarts).toBe(1);
    expect(f.reports[0]![1].outcome).toBe('done');
  });

  it('a vendor error that is not the browser does not restart it and is reported for a later retry', async () => {
    const f = fakes(['a'], async () => { throw new Error('ClikDeploy refused'); });
    await runLoop(f.ports, limits());
    expect(f.restarts()).toBe(0);
    expect(f.reports[0]![1]).toMatchObject({ outcome: 'retry' });
  });
});

describe('reports and the log', () => {
  it('success is reported done; a human wall is reported blocked with its typed kind; one log line per vendor with ids, calls, minutes, outcome, wall', async () => {
    const f = fakes(['good', 'walled'], async (id, ctx) => {
      ctx.budget.spend(); ctx.budget.spend();
      return id === 'good' ? outcome(id) : outcome(id, { status: 'human', summary: 'a captcha on the sign-up form', humanStep: { kind: 'captcha', instructions: 'solve it' } });
    });
    const sum = await runLoop(f.ports, limits());
    expect(f.reports.find(([id]) => id === 'good')![1]).toMatchObject({ outcome: 'done' });
    const walled = f.reports.find(([id]) => id === 'walled')![1];
    expect(walled).toMatchObject({ outcome: 'blocked', humanStep: { kind: 'captcha' } });
    expect(walled.reason).toMatch(/^wall:captcha:/);
    expect(sum.done).toMatchObject({ published: 1, wall: 1 });
    const lines = f.log.filter(l => l.includes(' id='));
    expect(lines).toHaveLength(2);
    expect(lines.find(l => l.includes('id=walled'))).toMatch(/outcome=human wall=captcha calls=2 minutes=\d+\.\d steps=3 reported=blocked/);
  });

  it('a wall the server already holds is not reported again', async () => {
    const f = fakes(['a'], async id => outcome(id, { status: 'human', summary: 's', recorded: 'ClikDeploy already holds this human step', humanStep: { kind: 'payment', instructions: 'card' } }));
    await runLoop(f.ports, limits());
    expect(f.reports).toHaveLength(0);
  });

  it('maps human steps and reason codes to the typed wall kinds', () => {
    const h = (kind: string, instructions = '', reasonCode?: string) => wallOf(outcome('x', { status: 'human', summary: '', humanStep: { kind, instructions, ...(reasonCode ? { reasonCode } : {}) } as never }));
    expect(h('captcha')).toBe('captcha');
    expect(h('mfa')).toBe('sms');
    expect(h('payment', 'a credit card')).toBe('card');
    expect(h('payment', 'the API needs the Pro plan')).toBe('paid-plan');
    expect(h('vendor-contact')).toBe('sales');
    expect(h('app-review')).toBe('app-review');
    expect(h('app-registration')).toBe('oauth-app');
    expect(h('retire', 'the domain no longer resolves')).toBe('dead-host');
    expect(h('retire', 'the vendor has no public API')).toBe('no-api');
    expect(h('decision', 'gmail addresses are not accepted')).toBe('free-mail');
    expect(h('decision', 'a work email is required')).toBe('work-email');
    expect(h('decision', 'choose', 'sales')).toBe('sales');
    expect(h('decision', 'choose')).toBeUndefined();
    expect(wallOf(outcome('x', { status: 'budget' }))).toBe('budget');
    expect(wallOf(outcome('x'))).toBeUndefined();
  });
});

describe('the loop itself', () => {
  it('stops taking vendors after --max-hours, finishes the ones running, and saves its state', async () => {
    const f = fakes(['a', 'b', 'c', 'd', 'e', 'f'], async id => { await wait(30); return outcome(id); });
    const sum = await runLoop(f.ports, limits({ parallel: 1, maxHoursMs: 50 }));
    expect(sum.vendors).toBeLessThan(6);
    expect(sum.vendors).toBeGreaterThan(0);
    expect(f.states.at(-1)).toMatchObject({ active: [], stopping: true });
    expect(f.states.some(s => s.active.length === 1)).toBe(true);
  });

  it('a stop request lets the running vendor finish and takes no more', async () => {
    let stop = false;
    const f = fakes(['a', 'b', 'c'], async id => { stop = true; await wait(20); return outcome(id); }, { stopRequested: () => stop });
    const sum = await runLoop(f.ports, limits({ parallel: 1, maxHoursMs: 5_000 }));
    expect(sum.vendors).toBe(1);
  });

  it('a queue that cannot be read is logged and retried, not fatal', async () => {
    let n = 0;
    const f = fakes([], async id => outcome(id), { next: async () => { if (++n < 3) throw new Error('offline'); return []; } });
    await runLoop(f.ports, limits({ maxHoursMs: 60 }));
    expect(f.log.filter(l => l.includes('could not read the queue')).length).toBe(2);
  });

  it('claims only needs-agent rows that no other worker holds', () => {
    const now = Date.now();
    const rows = [
      { id: 'a', stage: 'needs-agent' }, { id: 'b', stage: 'attention' }, { id: 'c', stage: 'needs-agent', leaseHolder: 'someone-else', leaseUntil: new Date(now + 60_000).toISOString() },
      { id: 'd', stage: 'needs-agent', leaseHolder: 'cc-runner', leaseUntil: new Date(now + 60_000).toISOString() }, { id: 'e', stage: 'needs-agent' },
    ];
    expect(claimable(rows, new Set(['e']), now, 3)).toEqual(['a', 'd']);
  });
});
