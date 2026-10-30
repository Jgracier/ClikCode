/** `clikcode connectors run --loop`: connector onboarding that never needs a person. This file is the control: what to take, how many at once, the
 * hard budgets, the cooldown, the back-off when the machine stalls, lease renewal, browser recovery and the typed wall report. Every outside thing
 * (ClikDeploy's queue, the browser, /proc, the clock, the log) is a port, so the control is tested with fakes (connector-loop.vitest.test.ts). */
import { scrubSecrets } from './secret-scrubber.js';
import type { DeployClient, VendorOutcome } from './connector-runner.js';

export const WALL_KINDS = ['captcha', 'sms', 'card', 'paid-plan', 'sales', 'app-review', 'oauth-app', 'free-mail', 'work-email', 'no-api', 'dead-host', 'budget'] as const;
export type WallKind = typeof WALL_KINDS[number];
const isWall = (v: unknown): v is WallKind => typeof v === 'string' && (WALL_KINDS as readonly string[]).includes(v);

/** Each vendor works in its own named tab, never the default one. */
export const tabName = (id: string): string => `loop-${id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)}`;

export class BudgetError extends Error { constructor(readonly max: number) { super(`call budget of ${max} ClikDeploy calls used`); } }
/** The calls one vendor may make to ClikDeploy (what the server sees of it). */
export class CallBudget {
  used = 0;
  constructor(readonly max: number) {}
  spend(): void { if (this.used >= this.max) throw new BudgetError(this.max); this.used++; }
}
/** `client`, with every call counted; past the budget a call throws BudgetError. */
export function budgeted(client: DeployClient, budget: CallBudget): DeployClient {
  const count = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => { try { budget.spend(); } catch (e) { return Promise.reject(e); } return fn(...a); };
  return { waiting: count(client.waiting.bind(client)), batch: count(client.batch.bind(client)), onboard: count(client.onboard.bind(client)), report: count(client.report.bind(client)), note: count(client.note.bind(client)), tool: count(client.tool.bind(client)) };
}

/** The wall a vendor stopped on, as one of the typed kinds. */
export function wallOf(o: VendorOutcome): WallKind | undefined {
  if (o.status === 'budget') return 'budget';
  if (o.status !== 'human' || !o.humanStep) return undefined;
  const h = o.humanStep;
  if (isWall(h.reasonCode)) return h.reasonCode;
  const text = `${h.instructions ?? ''} ${o.summary}`.toLowerCase();
  switch (h.kind) {
    case 'captcha': return 'captcha';
    case 'sms': case 'mfa': return 'sms';
    case 'payment': return /\bplan\b|pricing|upgrade|subscription|paid/.test(text) ? 'paid-plan' : 'card';
    case 'app-review': return 'app-review';
    case 'app-registration': return 'oauth-app';
    case 'vendor-contact': return 'sales';
    case 'retire': return /dead|resolve|unreachable|no longer|offline|404|parked|expired/.test(text) ? 'dead-host' : 'no-api';
    default:
      if (/free.?mail|gmail|personal e-?mail/.test(text)) return 'free-mail';
      if (/work.?e-?mail|business e-?mail|company e-?mail/.test(text)) return 'work-email';
      return undefined;
  }
}

/** One `some`/`full` line of /proc/pressure/*: the 10 second average. */
export function parsePressure(text: string | undefined): { some?: number; full?: number } {
  const out: { some?: number; full?: number } = {};
  for (const line of (text ?? '').split('\n')) {
    const m = /^(some|full)\b.*\bavg10=([\d.]+)/.exec(line.trim());
    if (m) out[m[1] as 'some' | 'full'] = Number(m[2]);
  }
  return out;
}
/** The machine is stalled when tasks are fully stalled on io or cpu more than `limit` percent of the last 10 seconds. */
export function stalledBy(io: string | undefined, cpu: string | undefined, limit = 10): { stalled: boolean; io?: number; cpu?: number } {
  const i = parsePressure(io).full, c = parsePressure(cpu).full;
  return { stalled: (i ?? 0) > limit || (c ?? 0) > limit, ...(i !== undefined ? { io: i } : {}), ...(c !== undefined ? { cpu: c } : {}) };
}

/** A vendor is not tried again before its cooldown ends. */
export class Cooldown {
  private readonly until = new Map<string, number>();
  constructor(private readonly defaultMs: number, private readonly now: () => number) {}
  mark(id: string, ms = this.defaultMs): void { this.until.set(id, this.now() + ms); }
  active(id: string): boolean { const u = this.until.get(id); if (u === undefined) return false; if (u <= this.now()) { this.until.delete(id); return false; } return true; }
  ids(): string[] { return [...this.until.keys()].filter(id => this.active(id)); }
  snapshot(): Record<string, string> { return Object.fromEntries(this.ids().map(id => [id, new Date(this.until.get(id)!).toISOString()])); }
  restore(saved: Record<string, string> | undefined): void { for (const [id, iso] of Object.entries(saved ?? {})) { const t = Date.parse(iso); if (Number.isFinite(t) && t > this.now()) this.until.set(id, t); } }
}

export interface LoopLimits {
  parallel: number;
  /** Hard budget per vendor. */ maxSteps: number; maxMs: number; maxCalls: number;
  /** No second try of one vendor before this. */ cooldownMs: number;
  /** A wall holds longer than a budget stop. */ wallCooldownMs: number;
  /** Stop starting vendors after this long, finish those running. */ maxHoursMs: number;
  renewMs: number; tickMs: number; idleMs: number;
  pauseBaseMs: number; pauseMaxMs: number; pressureLimit: number;
  /** Extra time past maxMs before a hung vendor is cut off. */ graceMs: number;
}
export const DEFAULT_LIMITS: LoopLimits = {
  parallel: 2, maxSteps: 12, maxMs: 5 * 60_000, maxCalls: 60, cooldownMs: 6 * 3_600_000, wallCooldownMs: 24 * 3_600_000, maxHoursMs: 8 * 3_600_000,
  renewMs: 10 * 60_000, tickMs: 15_000, idleMs: 60_000, pauseBaseMs: 30_000, pauseMaxMs: 5 * 60_000, pressureLimit: 10, graceMs: 90_000,
};

export interface WorkContext { tab: string; budget: CallBudget; limits: LoopLimits; deadline: number }
export interface LoopReport { outcome: 'done' | 'blocked' | 'retry'; reason: string; humanStep?: VendorOutcome['humanStep'] }
export interface LoopState {
  pid: number; startedAt: string; until: string; parallel: number; updatedAt: string; stopping?: boolean;
  active: Array<{ id: string; tab: string; since: string; calls: number }>;
  done: Record<string, number>; walls: Record<string, number>;
  cooldown: Record<string, string>;
  pressure?: { io?: number; cpu?: number; stalled: boolean; pausedUntil?: string };
}
export interface LoopPorts {
  /** Claims up to `n` due vendors that are not in `exclude`. */
  next(n: number, exclude: ReadonlySet<string>): Promise<Array<{ id: string }>>;
  renew(id: string): Promise<void>;
  /** Works one vendor in its own tab to a finished outcome. */
  work(id: string, ctx: WorkContext): Promise<VendorOutcome>;
  report(id: string, report: LoopReport): Promise<void>;
  pressure(): Promise<{ stalled: boolean; io?: number; cpu?: number }>;
  closeTab(id: string): Promise<void>;
  /** Restarts the shared browser; vendors working at that moment fail and are resumed once. */
  restartBrowser(): Promise<void>;
  log(line: string): void;
  saveState(state: LoopState): Promise<void>;
  loadCooldown?(): Promise<Record<string, string> | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  stopRequested?(): boolean;
  pid?: number;
}
export interface LoopSummary { vendors: number; done: Record<string, number>; walls: Record<string, number>; pauses: number; restarts: number; renewals: number }

const BROWSER_HANG = /target (?:page, context or browser has been )?closed|browser has been closed|browser(?: process)? (?:disconnected|crashed)|connection closed|websocket|cdp|session closed|page crashed|has no open tab|econnrefused/i;

export async function runLoop(ports: LoopPorts, limits: LoopLimits): Promise<LoopSummary> {
  const { now, sleep } = ports;
  const started = now();
  const endAt = started + limits.maxHoursMs;
  const cooldown = new Cooldown(limits.cooldownMs, now);
  cooldown.restore(await ports.loadCooldown?.().catch(() => undefined));
  const active = new Map<string, { job: Promise<void>; since: number; lastRenew: number; budget: CallBudget; tab: string }>();
  const summary: LoopSummary = { vendors: 0, done: {}, walls: {}, pauses: 0, restarts: 0, renewals: 0 };
  let stalls = 0, pausedUntil: number | undefined, last: { stalled: boolean; io?: number; cpu?: number } = { stalled: false };
  let restarting: Promise<void> | undefined;
  const restart = (): Promise<void> => {
    if (!restarting) { summary.restarts++; restarting = ports.restartBrowser().catch(() => undefined).finally(() => { restarting = undefined; }); }
    return restarting;
  };
  const save = (stopping: boolean): Promise<void> => ports.saveState({
    pid: ports.pid ?? process.pid, startedAt: new Date(started).toISOString(), until: new Date(endAt).toISOString(), parallel: limits.parallel, updatedAt: new Date(now()).toISOString(), ...(stopping ? { stopping: true } : {}),
    active: [...active].map(([id, a]) => ({ id, tab: a.tab, since: new Date(a.since).toISOString(), calls: a.budget.used })),
    done: summary.done, walls: summary.walls, cooldown: cooldown.snapshot(),
    pressure: { ...last, ...(pausedUntil && pausedUntil > now() ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}) },
  }).catch(() => undefined);

  const finish = async (id: string, outcome: VendorOutcome, began: number, budget: CallBudget): Promise<void> => {
    const wall = wallOf(outcome);
    const minutes = (now() - began) / 60_000;
    const kind = outcome.status === 'published' ? 'published' : wall ? 'wall' : outcome.status;
    summary.done[kind] = (summary.done[kind] ?? 0) + 1;
    if (wall) summary.walls[wall] = (summary.walls[wall] ?? 0) + 1;
    cooldown.mark(id, wall && wall !== 'budget' ? limits.wallCooldownMs : limits.cooldownMs);
    const reason = scrubSecrets(outcome.summary).replace(/\s+/g, ' ').slice(0, 400);
    let report: LoopReport | undefined;
    if (outcome.status === 'published') report = { outcome: 'done', reason: reason || 'published' };
    else if (outcome.status === 'human' && wall && !/already holds/.test(outcome.recorded ?? '')) report = { outcome: 'blocked', reason: `wall:${wall}: ${reason}`.padEnd(10, '.').slice(0, 480), ...(outcome.humanStep ? { humanStep: outcome.humanStep } : {}) };
    else if (outcome.status === 'budget' || outcome.status === 'error' || outcome.status === 'handoff') report = { outcome: 'retry', reason: `${wall === 'budget' ? 'wall:budget' : outcome.status}: ${reason}`.padEnd(10, '.').slice(0, 480) };
    let reported = report ? report.outcome : 'none';
    if (report) await ports.report(id, report).catch(error => { reported = `${report!.outcome}-failed(${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 80)})`; });
    ports.log(`${new Date(now()).toISOString()} id=${id} outcome=${outcome.status} wall=${wall ?? '-'} calls=${budget.used} minutes=${minutes.toFixed(1)} steps=${outcome.steps} reported=${reported}${outcome.recipe ? ' recipe=yes' : ''} ${JSON.stringify(reason.slice(0, 160))}`);
  };

  const start = (id: string): void => {
    cooldown.mark(id);
    summary.vendors++;
    const began = now();
    const budget = new CallBudget(limits.maxCalls);
    const tab = tabName(id);
    const job = (async (): Promise<void> => {
      const ctx: WorkContext = { tab, budget, limits, deadline: began + limits.maxMs };
      const hard = new Promise<'timeout'>(resolve => { void sleep(limits.maxMs + limits.graceMs).then(() => resolve('timeout')); });
      const run = async (): Promise<VendorOutcome> => {
        try { return await ports.work(id, ctx); } catch (error) {
          const message = scrubSecrets(error instanceof Error ? error.message : String(error));
          if (error instanceof BudgetError) return { id, status: 'budget', steps: 0, browserActions: 0, stage: '', summary: message, actions: [] };
          throw error;
        }
      };
      let outcome: VendorOutcome;
      try {
        let raced = await Promise.race([run().catch((e: unknown) => ({ failed: e })), hard]);
        // A browser that hung or went away: restart it and resume this vendor once (the server keeps its progress), if time remains.
        if (raced !== 'timeout' && 'failed' in raced) {
          const message = raced.failed instanceof Error ? raced.failed.message : String(raced.failed);
          if (BROWSER_HANG.test(message) && now() < ctx.deadline) {
            ports.log(`${new Date(now()).toISOString()} id=${id} browser trouble (${scrubSecrets(message).slice(0, 80)}); restarting the browser and resuming`);
            await ports.closeTab(id).catch(() => undefined);
            await restart();
            raced = await Promise.race([run().catch((e: unknown) => ({ failed: e })), hard]);
          }
        }
        if (raced === 'timeout') {
          await ports.closeTab(id).catch(() => undefined);
          await restart();
          outcome = { id, status: 'budget', steps: 0, browserActions: 0, stage: '', summary: `hard time limit of ${Math.round((limits.maxMs + limits.graceMs) / 1000)}s: the browser did not answer; the tab and the browser were restarted`, actions: [] };
        } else if ('failed' in raced) {
          const message = scrubSecrets(raced.failed instanceof Error ? raced.failed.message : String(raced.failed));
          if (BROWSER_HANG.test(message)) await restart();
          outcome = { id, status: 'error', steps: 0, browserActions: 0, stage: '', summary: message.slice(0, 300), actions: [] };
        } else outcome = raced;
      } finally { await ports.closeTab(id).catch(() => undefined); }
      await finish(id, outcome, began, budget);
    })().catch(() => undefined).finally(() => { active.delete(id); });
    active.set(id, { job, since: began, lastRenew: began, budget, tab });
  };

  for (;;) {
    const t = now();
    const draining = t >= endAt || ports.stopRequested?.() === true;
    for (const [id, a] of active) if (t - a.lastRenew >= limits.renewMs) { a.lastRenew = t; summary.renewals++; await ports.renew(id).catch(error => ports.log(`${new Date(t).toISOString()} id=${id} lease renewal failed: ${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 100)}`)); }
    if (draining && !active.size) break;
    let waitMs = limits.tickMs;
    if (!draining) {
      if (pausedUntil !== undefined && t < pausedUntil) waitMs = Math.min(pausedUntil - t, limits.tickMs);
      else {
        last = await ports.pressure().catch(() => ({ stalled: false }));
        if (last.stalled) {
          stalls++;
          const pause = Math.min(limits.pauseBaseMs * 2 ** (stalls - 1), limits.pauseMaxMs);
          pausedUntil = t + pause;
          summary.pauses++;
          ports.log(`${new Date(t).toISOString()} machine stalled (io full ${last.io ?? '-'}%, cpu full ${last.cpu ?? '-'}%): no new vendors for ${Math.round(pause / 1000)}s`);
          waitMs = Math.min(pause, limits.tickMs);
        } else {
          stalls = 0; pausedUntil = undefined;
          const slots = limits.parallel - active.size;
          if (slots > 0) {
            const exclude = new Set([...cooldown.ids(), ...active.keys()]);
            const items = await ports.next(slots, exclude).catch(error => { ports.log(`${new Date(t).toISOString()} could not read the queue: ${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 100)}`); return []; });
            for (const item of items) if (!exclude.has(item.id) && active.size < limits.parallel) start(item.id);
            if (!items.length && !active.size) waitMs = limits.idleMs;
          }
        }
      }
    }
    await save(draining);
    await Promise.race([...[...active.values()].map(a => a.job), sleep(waitMs)]);
  }
  await save(true);
  return summary;
}
