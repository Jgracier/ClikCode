/** `clikcode connectors run --loop`: connector onboarding that never needs a person. This file is the control: what to take, how many at once, the
 * hard budgets, the cooldown, the back-off when the machine stalls, lease renewal, browser recovery and the typed wall report. Every outside thing
 * (ClikDeploy's queue, the browser, /proc, the clock, the log) is a port, so the control is tested with fakes (connector-loop.vitest.test.ts). */
import { quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from './secret-scrubber.js';
import type { DeployClient, VendorOutcome } from './connector-runner.js';

const WALL_KINDS = ['captcha', 'sms', 'card', 'paid-plan', 'sales', 'app-review', 'oauth-app', 'free-mail', 'work-email', 'no-api', 'dead-host', 'budget'] as const;
type WallKind = typeof WALL_KINDS[number];
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

/** A step's reason code (keygrab, the runner, qualify, or ClikDeploy's own -- its kind where it sent none, connector-runner.ts planFor)
 * as a typed wall, where it is not already one. The page was read once, by whoever set the code; nothing here reads text again. */
const REASON_WALLS: Readonly<Record<string, WallKind>> = {
  'phone-verification': 'sms', 'verification-code': 'sms', mfa: 'sms',
  payment: 'card',
  'approval-needed': 'sales', 'vendor-contact': 'sales',
  'app-registration': 'oauth-app', 'oauth-client-unknown': 'oauth-app',
  'domain-for-sale': 'dead-host', 'host-dead': 'dead-host',
  'vendor-retired': 'no-api', retire: 'no-api',
};

/** The wall a vendor stopped on, as one of the typed kinds. */
export function wallOf(o: VendorOutcome): WallKind | undefined {
  if (o.status === 'budget') return 'budget';
  if (o.status !== 'human' || !o.humanStep) return undefined;
  const code = o.humanStep.reasonCode;
  return isWall(code) ? code : REASON_WALLS[code];
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
  clear(id: string): void { this.until.delete(id); }
  ids(): string[] { return [...this.until.keys()].filter(id => this.active(id)); }
  snapshot(): Record<string, string> { return Object.fromEntries(this.ids().map(id => [id, new Date(this.until.get(id)!).toISOString()])); }
  restore(saved: Record<string, string> | undefined): void { for (const [id, iso] of Object.entries(saved ?? {})) { const t = Date.parse(iso); if (Number.isFinite(t) && t > this.now()) this.until.set(id, t); } }
}

export interface LoopLimits {
  parallel: number;
  /** Hard budget per vendor. */ maxSteps: number; maxMs: number; maxCalls: number;
  /** One agent hand-off's own budget, on top of the vendor's: minutes and tool calls for judgement work. */ agentMs: number; agentCalls: number;
  /** No second try of one vendor before this. */ cooldownMs: number;
  /** A wall holds longer than a budget stop. */ wallCooldownMs: number;
  /** A vendor is cut off when nothing has happened for this long: no browser action in its tabs, no new step, no agent running. */ stallMs?: number;
  /** Stop starting vendors after this long, finish those running. */ maxHoursMs: number;
  renewMs: number; tickMs: number; idleMs: number;
  pauseBaseMs: number; pauseMaxMs: number; pressureLimit: number;
  /** Pause new claims while the chat's account has no usage left (every agent would fail); active vendors finish and are retried. */ agentOutagePauseMs: number;
  /** Extra time past maxMs before a hung vendor is cut off. */ graceMs: number;
}
export const DEFAULT_LIMITS: LoopLimits = {
  parallel: 2, maxSteps: 12, maxMs: 5 * 60_000, maxCalls: 60, agentMs: 20 * 60_000, agentCalls: 120, cooldownMs: 6 * 3_600_000, wallCooldownMs: 24 * 3_600_000, stallMs: 5 * 60_000, maxHoursMs: 8 * 3_600_000,
  renewMs: 10 * 60_000, tickMs: 15_000, idleMs: 60_000, pauseBaseMs: 30_000, pauseMaxMs: 5 * 60_000, pressureLimit: 10, agentOutagePauseMs: 5 * 60_000, graceMs: 90_000,
};

export interface WorkContext {
  tab: string; budget: CallBudget; limits: LoopLimits; deadline: number; signal?: AbortSignal;
  /** The last action the vendor started, set by the work. */ last?: string;
  /** When the work last showed progress (a new step), set by the work. */ progressAt?: number;
  /** Time spent in agent hand-offs so far, and when the running one began: that time is the agent's budget (limits.agentMs), not the vendor's. */
  agentMs?: number; agentSince?: number;
}

/** How long a vendor may run before it is cut off: its own time, the grace, and the time its agent hand-offs took (at most limits.agentMs). */
export function allowedMs(ctx: Pick<WorkContext, 'limits' | 'agentMs' | 'agentSince'>, at: number): number {
  const agent = (ctx.agentMs ?? 0) + (ctx.agentSince !== undefined ? at - ctx.agentSince : 0);
  return ctx.limits.maxMs + ctx.limits.graceMs + Math.min(agent, ctx.limits.agentMs);
}
/** A browser that did not open is a fault of ours, not a verdict on the vendor: try the vendor again in minutes, not hours. */
/** A vendor that did not get its turn because something it runs on was down -- the browser, or the agent (the chat's account out of usage,
 * a harness that would not start) -- says nothing about the vendor: it is tried again in minutes, not shelved for hours like a wall. On 2026-11-17 an unavailable
 * model shelved 225 vendors for six hours each. */
const BROWSER_DOWN = /ClikCode browser is busy|Chrome is open outside ClikCode|browser (is|was) (blocked|unavailable)|the agent could not run/i;
const BROWSER_RETRY_MS = 5 * 60_000;
/** A vendor whose captcha was not cleared is tried again after this (keygrab-park.ts BACKOFF_HOURS holds it as long). */
const CAPTCHA_RETRY_MS = 3_600_000;
/** Runs in a row an agent hand-off may end the same unfinished way before the vendor is parked as attention. */
export const STUCK_AFTER = 3;

export interface LoopReport { outcome: 'done' | 'blocked' | 'retry'; reason: string; retryAfterMs?: number; humanStep?: VendorOutcome['humanStep'] }
export interface LoopState {
  pid: number; startedAt: string; until: string; parallel: number; updatedAt: string; stopping?: boolean;
  active: Array<{ id: string; tab: string; since: string; calls: number }>;
  done: Record<string, number>; walls: Record<string, number>;
  cooldown: Record<string, string>;
  /** Vendors whose agent hand-off ended the same way run after run: the reason and how many times in a row. */
  stuck?: Record<string, { reason: string; count: number }>;
  pressure?: { io?: number; cpu?: number; memory?: number; stalled: boolean; pausedUntil?: string };
}
export interface LoopPorts {
  /** Claims up to `n` due vendors that are not in `exclude`. */
  next(n: number, exclude: ReadonlySet<string>): Promise<Array<{ id: string }>>;
  renew(id: string): Promise<void>;
  /** Works one vendor in its own tab to a finished outcome. */
  work(id: string, ctx: WorkContext): Promise<VendorOutcome>;
  /** When the vendor's own tabs (its tab and its agent's) were last used in the browser. */
  activity?(id: string): Promise<number | undefined>;
  report(id: string, report: LoopReport): Promise<void>;
  pressure(): Promise<{ stalled: boolean; io?: number; cpu?: number; memory?: number }>;
  closeTab(id: string): Promise<void>;
  log(line: string): void;
  saveState(state: LoopState): Promise<void>;
  /** Vendors whose human step the user just finished (on the handoff desk): they are due again now, whatever their cooldown. */
  finishedByUser?(): Promise<string[]>;
  loadCooldown?(): Promise<Record<string, string> | undefined>;
  loadStuck?(): Promise<LoopState['stuck']>;
  now(): number;
  sleep(ms: number): Promise<void>;
  stopRequested?(): boolean;
  pid?: number;
}
interface LoopSummary { vendors: number; done: Record<string, number>; walls: Record<string, number>; pauses: number; restarts: number; renewals: number }

/** The browser (not the vendor) failed the task: by what the error is when it says -- Playwright's TargetClosedError, a refused or reset
 * connection to the browser -- else by its words, for an error our own code wrapped in a plain one. */
export function browserTrouble(error: unknown): boolean {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  if (name === 'TargetClosedError' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  return BROWSER_HANG.test(error instanceof Error ? error.message : String(error));
}
const BROWSER_HANG = /target (?:page, context or browser has been )?closed|browser has been closed|browser(?: process)? (?:disconnected|crashed)|connection closed|websocket|cdp|session closed|page crashed|has no open tab|econnrefused/i;

export async function runLoop(ports: LoopPorts, limits: LoopLimits): Promise<LoopSummary> {
  const { now, sleep } = ports;
  const started = now();
  const endAt = started + limits.maxHoursMs;
  const cooldown = new Cooldown(limits.cooldownMs, now);
  cooldown.restore(await ports.loadCooldown?.().catch(quiet('agent/computer/connector-loop')));
  // An agent hand-off that ends the same way STUCK_AFTER runs in a row is parked as attention instead of retried every cooldown
  // forever (lambdatest, nexmo-conversion, convergehub: one judgement task re-run for days with the same result).
  const stuck: NonNullable<LoopState['stuck']> = { ...(await ports.loadStuck?.().catch(quiet('agent/computer/connector-loop')) ?? {}) };
  const active = new Map<string, { job: Promise<void>; since: number; lastRenew: number; budget: CallBudget; tab: string }>();
  const summary: LoopSummary = { vendors: 0, done: {}, walls: {}, pauses: 0, restarts: 0, renewals: 0 };
  let stalls = 0, pausedUntil: number | undefined, last: { stalled: boolean; io?: number; cpu?: number; memory?: number } = { stalled: false };
  const save = (stopping: boolean): Promise<void> => ports.saveState({
    pid: ports.pid ?? process.pid, startedAt: new Date(started).toISOString(), until: new Date(endAt).toISOString(), parallel: limits.parallel, updatedAt: new Date(now()).toISOString(), ...(stopping ? { stopping: true } : {}),
    active: [...active].map(([id, a]) => ({ id, tab: a.tab, since: new Date(a.since).toISOString(), calls: a.budget.used })),
    done: summary.done, walls: summary.walls, cooldown: cooldown.snapshot(), stuck,
    pressure: { ...last, ...(pausedUntil && pausedUntil > now() ? { pausedUntil: new Date(pausedUntil).toISOString() } : {}) },
  }).catch(quiet('agent/computer/connector-loop'));

  const finish = async (id: string, outcome: VendorOutcome, began: number, budget: CallBudget): Promise<void> => {
    const wall = wallOf(outcome);
    const minutes = (now() - began) / 60_000;
    const kind = outcome.status === 'published' ? 'published' : wall ? 'wall' : outcome.status;
    summary.done[kind] = (summary.done[kind] ?? 0) + 1;
    if (wall) summary.walls[wall] = (summary.walls[wall] ?? 0) + 1;
    // The chat's account has no usage left: every agent hand-off would fail the same way until it renews.
    const providerDown = !wall && outcome.status !== 'published' && /has no usage left now/i.test(outcome.summary);
    const browserDown = !wall && outcome.status !== 'published' && BROWSER_DOWN.test(outcome.summary);
    // A captcha wall is the one wall worth an early second try: the solver may clear it once the site has cooled.
    const dependencyRetryMs = providerDown ? limits.agentOutagePauseMs : BROWSER_RETRY_MS;
    const waitingRetryMs = outcome.status === 'waiting' ? Math.max(1_000, Math.min(outcome.retryAfterMs ?? (outcome.backoffUntil ? Date.parse(outcome.backoffUntil) - now() : BROWSER_RETRY_MS), 60 * 60_000)) : undefined;
    cooldown.mark(id, waitingRetryMs ?? (browserDown ? dependencyRetryMs : wall === 'captcha' ? CAPTCHA_RETRY_MS : wall && wall !== 'budget' ? limits.wallCooldownMs : limits.cooldownMs));
    const reason = scrubSecrets(outcome.summary).replace(/\s+/g, ' ').slice(0, 400);
    let report: LoopReport | undefined;
    // The same unfinished hand-off again: counted, and parked once it has happened STUCK_AFTER times in a row.
    let parkStuck = false;
    if (outcome.status === 'handoff' && !browserDown && !providerDown) {
      const key = `${outcome.stage}|${reason.replace(/\(\d+ (?:tool )?calls\)|\d+/g, '').slice(0, 90)}`;
      stuck[id] = stuck[id]?.reason === key ? { reason: key, count: stuck[id]!.count + 1 } : { reason: key, count: 1 };
      parkStuck = stuck[id]!.count >= STUCK_AFTER;
    } else if (outcome.status !== 'waiting' && !browserDown && !providerDown) delete stuck[id];
    if (parkStuck) {
      report = { outcome: 'blocked', reason: `wall:agent-stuck: the same agent task ended unfinished ${stuck[id]!.count} runs in a row: ${reason}`.slice(0, 480), humanStep: { kind: 'decision', reasonCode: 'agent-stuck', instructions: `An agent tried this ${stuck[id]!.count} times and ended the same way each time: ${reason}`.slice(0, 300) } };
      delete stuck[id];
    } else if (outcome.status === 'published') report = { outcome: 'done', reason: reason || 'published' };
    else if (outcome.status === 'human' && wall && !/already holds/.test(outcome.recorded ?? '')) report = { outcome: 'blocked', reason: `wall:${wall}: ${reason}`.padEnd(10, '.').slice(0, 480), ...(outcome.humanStep ? { humanStep: outcome.humanStep } : {}) };
    else if (outcome.status === 'budget' || outcome.status === 'error' || outcome.status === 'handoff' || outcome.status === 'waiting') report = { outcome: 'retry', retryAfterMs: waitingRetryMs ?? (browserDown ? dependencyRetryMs : limits.cooldownMs), reason: `${wall === 'budget' ? 'wall:budget' : outcome.status}: ${reason}`.padEnd(10, '.').slice(0, 480) };
    let reported = report ? report.outcome : 'none';
    if (report) await ports.report(id, report).catch(error => { reported = `${report!.outcome}-failed(${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 80)})`; });
    const finishedAt = now();
    if (providerDown) {
      pausedUntil = Math.max(pausedUntil ?? 0, finishedAt + limits.agentOutagePauseMs);
      summary.pauses++;
      ports.log(`${new Date(finishedAt).toISOString()} the chat's account has no usage left: no new connector claims for ${Math.round(limits.agentOutagePauseMs / 1000)}s; active work continues`);
    }
    ports.log(`${new Date(finishedAt).toISOString()} id=${id} outcome=${outcome.status} wall=${wall ?? '-'} calls=${budget.used} minutes=${minutes.toFixed(1)} steps=${outcome.steps} reported=${reported}${outcome.recipe ? ' recipe=yes' : ''} ${JSON.stringify(reason.slice(0, 160))}`);
  };

  const start = (id: string): void => {
    cooldown.mark(id);
    summary.vendors++;
    const began = now();
    const budget = new CallBudget(limits.maxCalls);
    const tab = tabName(id);
    const job = (async (): Promise<void> => {
      const abort = new AbortController();
      const ctx: WorkContext = { signal: abort.signal, tab, budget, limits, deadline: began + limits.maxMs + limits.agentMs };
      // The hard limit grows while an agent hand-off runs: cutting one off at the vendor's own limit ended every long
      // judgement task as "out of time" (49 of 58 time-outs on 2026-11-15) with its own 20 minutes barely begun.
      // And it is a STALL limit, not a clock: work that keeps acting (browser actions in its tabs, new steps, an agent running) is
      // never cut off for taking long; only work that has done nothing for stallMs is, or work past the ceiling. Keygrab on a loaded
      // browser was cut mid-run ("hard time limit during keygrab", 47 runs on 2026-11-18) while still clicking.
      let stopped = false, stalled = false;
      const stallMs = limits.stallMs ?? limits.maxMs;
      const hard = (async (): Promise<'timeout'> => {
        for (;;) {
          const at = now();
          const seen = await ports.activity?.(id).catch(() => undefined);
          const progressAt = Math.max(began, ctx.progressAt ?? 0, seen ?? 0, ctx.agentSince !== undefined ? at : 0);
          const ceiling = began + allowedMs(ctx, at) - at;
          const idle = progressAt + stallMs + limits.graceMs - at;
          if (stopped) return 'timeout';
          if (ceiling <= 0 || idle <= 0) { stalled = idle <= 0 && ceiling > 0; return 'timeout'; }
          await sleep(Math.min(ceiling, idle, 5_000));
        }
      })();
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
        // Close only this task’s tabs and resume once if time remains; other tasks share the browser host.
        if (raced !== 'timeout' && 'failed' in raced) {
          const message = raced.failed instanceof Error ? raced.failed.message : String(raced.failed);
          if (browserTrouble(raced.failed) && now() < ctx.deadline) {
            ports.log(`${new Date(now()).toISOString()} id=${id} browser trouble (${scrubSecrets(message).slice(0, 80)}); closing this task’s tabs and resuming`);
            await ports.closeTab(id).catch(quiet('agent/computer/connector-loop'));
            raced = await Promise.race([run().catch((e: unknown) => ({ failed: e })), hard]);
          }
        }
        if (raced === 'timeout') {
          abort.abort(new Error('Connector task deadline expired'));
          await ports.closeTab(id).catch(quiet('agent/computer/connector-loop'));
          outcome = { id, status: 'budget', steps: 0, browserActions: 0, stage: '', summary: `${stalled ? `no progress for ${Math.round((stallMs + limits.graceMs) / 1000)}s` : `hard time limit of ${Math.round(allowedMs(ctx, now()) / 1000)}s`} ${ctx.last ? `during "${ctx.last.slice(0, 120)}"` : 'before the first step'}; the task was cancelled and its own tabs were closed`, actions: [] };
        } else if ('failed' in raced) {
          const message = scrubSecrets(raced.failed instanceof Error ? raced.failed.message : String(raced.failed));
          if (browserTrouble(raced.failed)) await ports.closeTab(id).catch(quiet('agent/computer/connector-loop'));
          outcome = { id, status: 'error', steps: 0, browserActions: 0, stage: '', summary: message.slice(0, 300), actions: [] };
        } else outcome = raced;
      } finally { stopped = true; await ports.closeTab(id).catch(quiet('agent/computer/connector-loop')); }
      await finish(id, outcome, began, budget);
    })().catch(quiet('agent/computer/connector-loop')).finally(() => { active.delete(id); });
    active.set(id, { job, since: began, lastRenew: began, budget, tab });
  };

  let lastQueueError = '', lastQueueErrorAt = 0;
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
          ports.log(`${new Date(t).toISOString()} machine stalled (io full ${last.io ?? '-'}%, cpu full ${last.cpu ?? '-'}%, memory full ${last.memory ?? '-'}%): no new vendors for ${Math.round(pause / 1000)}s`);
          waitMs = Math.min(pause, limits.tickMs);
        } else {
          stalls = 0; pausedUntil = undefined;
          for (const id of await ports.finishedByUser?.().catch(() => [] as string[]) ?? []) {
            cooldown.clear(id);
            ports.log(`${new Date(t).toISOString()} id=${id} the user finished its browser step: due again now`);
          }
          const slots = limits.parallel - active.size;
          if (slots > 0) {
            const exclude = new Set([...cooldown.ids(), ...active.keys()]);
            const items = await ports.next(slots, exclude).catch(error => { const said = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 100); if (said !== lastQueueError || t - lastQueueErrorAt >= 600_000) { lastQueueError = said; lastQueueErrorAt = t; ports.log(`${new Date(t).toISOString()} could not read the queue (said once per 10 minutes while it lasts): ${said}`); } return []; });
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
