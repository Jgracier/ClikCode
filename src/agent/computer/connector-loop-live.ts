/** The real ports of the connector loop: ClikDeploy's queue through its CLI, the ClikCode browser in one named tab per vendor, /proc/pressure, the
 * log (~/.clikcode/connector-loop.log) and the state file the `connectors status` command reads. */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quiet } from '../../runtime/lifecycle-log.js';
import { pidIsAlive } from '../../session/store/locks.js';
import type { DeployClient, HumanStep, OnboardResult } from './connector-runner.js';
import { runVendor } from './connector-runner.js';
import { budgeted, stalledBy, tabName, type LoopPorts, type LoopState, type WorkContext } from './connector-loop.js';
import { liveDriver, WORKER } from './connector-runner-live.js';
import { memoryPressure } from './connector-resource-pressure.js';
import { microTab } from './connector-micro-agent.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { sleep } from '../../runtime/sleep.js';

const loopDir = (): string => join(homedir(), '.clikcode');
export const loopLogPath = (): string => join(loopDir(), 'connector-loop.log');
const loopStatePath = (): string => join(loopDir(), 'connector-loop.json');

export async function readLoopState(): Promise<LoopState | undefined> {
  try { return JSON.parse(await readFile(loopStatePath(), 'utf8')) as LoopState; } catch { return undefined; }
}
export const alive = (pid: number | undefined): boolean => pid !== undefined && pidIsAlive(pid);

/** The queue rows worth claiming: waiting for an agent, with no other worker's live lease. */
export function claimable(rows: Array<Record<string, unknown>>, exclude: ReadonlySet<string>, nowMs: number, n: number): string[] {
  return rows.filter(r => typeof r.id === 'string' && r.stage === 'needs-agent' && !exclude.has(r.id as string) && !(typeof r.nextAttemptAt === 'string' && Date.parse(r.nextAttemptAt) > nowMs)
    && !(typeof r.leaseUntil === 'string' && Date.parse(r.leaseUntil) > nowMs && r.leaseHolder && !String(r.leaseHolder).includes(WORKER))).map(r => r.id as string).slice(0, Math.max(n, 0) * 4);
}

/** A feeder's docs task is already qualified work; onboarding again first used to replace it with a signup task. */
export function claimedTask(claim: { id?: string; lane?: string; task?: string; reason?: string } | null): OnboardResult | undefined {
  if (!claim?.id || claim.lane !== 'needs-spec' || !claim.task?.startsWith('docs-to-spec:')) return undefined;
  return { id: claim.id, state: 'needs-agent', stage: 'needs-agent', reason: claim.reason ?? 'Read official API documentation', next: { kind: 'agent', task: claim.task } };
}

export function livePorts(client: DeployClient, stateDir: string, extra: { stopRequested: () => boolean }): LoopPorts {
  const tasks = new Map<string, OnboardResult>();
  const notes = new Map<string, string>();
  let queueCursor: string | undefined;
  const append = async (line: string): Promise<void> => { await mkdir(loopDir(), { recursive: true }); await appendFile(loopLogPath(), `${line}\n`, { mode: 0o600 }); };
  return {
    pid: process.pid,
    now: Date.now,
    sleep,
    stopRequested: extra.stopRequested,
    log: line => { void append(line).catch(quiet('agent/computer/connector-loop-live')); },
    async next(n, exclude) {
      const got: Array<{ id: string }> = [];
      for (let page = 0; page < 5 && got.length < n; page++) {
      const data = await client.tool('connector_work_overview', { stage: 'needs-agent', limit: 100, ...(queueCursor ? { cursor: queueCursor } : {}) }) as { rows?: Array<Record<string, unknown>>; nextCursor?: string | null };
      queueCursor = data.nextCursor ?? undefined;
      for (const id of claimable(data.rows ?? [], exclude, Date.now(), n)) {
        if (got.length >= n) break;
        const claim = await client.tool('connector_work_claim', { id, stage: 'needs-agent', worker: WORKER }).catch(() => null) as { id?: string; lane?: string; task?: string; reason?: string; scratchpad?: { text: string } } | null;
        if (claim && claim.id === id) {
          const task = claimedTask(claim);
          if (task) tasks.set(id, task);
          if (claim.scratchpad?.text) notes.set(id, claim.scratchpad.text);
          got.push({ id });
        }
      }
      if (!queueCursor) break;
      }
      return got;
    },
    async renew(id) { await client.tool('connector_work_renew', { id, worker: WORKER }); },
    async work(id, ctx: WorkContext) {
      const counted = budgeted(ctx.signal && client.withSignal ? client.withSignal(ctx.signal) : client, ctx.budget);
      const driver = liveDriver({ stateDir, tab: ctx.tab, keepBrowser: true, signal: ctx.signal });
      const micro = driver.agentTask;
      // An agent hand-off has its own call and time budget (limits.agentCalls, limits.agentMs): the vendor's call budget guards
      // the deterministic steps, and spending it on the agent left judgement work a few calls and the last seconds of the vendor.
      if (micro) driver.agentTask = (id, stop, budget) => micro(id, stop, budget);
      const first = tasks.get(id) ?? await counted.onboard(id);
      tasks.delete(id);
      const saved = notes.get(id);
      notes.delete(id);
      if (saved && first.next.kind === 'agent') first.next.task += `\nSaved progress from the previous worker (verify before continuing):\n${saved}`;
      const { limits } = ctx;
      return runVendor(first, counted, driver, { maxSteps: limits.maxSteps, maxMs: limits.maxMs, agentMs: limits.agentMs, agentCalls: limits.agentCalls, log: line => void append(`${new Date().toISOString()} id=${id} ${line}`).catch(quiet('agent/computer/connector-loop-live')) }, job => job());
    },
    async report(id, report) {
      await client.report({ id, outcome: report.outcome, reason: report.reason, ...(report.retryAfterMs ? { retryAfterMs: report.retryAfterMs } : {}), ...(report.humanStep ? { humanStep: report.humanStep as HumanStep } : {}) });
    },
    async pressure() {
      const read = (name: string): Promise<string | undefined> => readFile(`/proc/pressure/${name}`, 'utf8').catch(quiet('agent/computer/connector-loop-live'));
      const pressure = stalledBy(await read('io'), await read('cpu'), 10);
      const memory = await memoryPressure();
      return { ...pressure, memory, stalled: pressure.stalled || (memory ?? 0) > 10 };
    },
    async closeTab(id) {
      const { closeComputerPage } = await import('./browser.js');
      await closeComputerPage(stateDir, tabName(id)).catch(quiet('agent/computer/connector-loop-live'));
      await closeComputerPage(stateDir, microTab(id)).catch(quiet('agent/computer/connector-loop-live'));
    },
    async saveState(state) {
      await atomicWriteFile(loopStatePath(), `${JSON.stringify(state, null, 1)}\n`, { durable: false });
    },
    async loadCooldown() { return (await readLoopState())?.cooldown; },
    async finishedByUser() {
      const [desk, park] = await Promise.all([import('./handoff-desk-store.js'), import('./keygrab-park.js')]);
      const ids: string[] = [];
      for (const item of await desk.takeFinishedResumes(stateDir)) {
        const id = item.resume!;
        await park.clearBackoff(stateDir, id).catch(quiet('agent/computer/connector-loop-live'));
        // The platform holds the vendor on its attention list until told the step was done; then its own check puts it back in the queue.
        await client.tool('connector_attention_resolve', { id, note: `the user finished the ${item.kind} step in the browser`, confirm: true }).catch(quiet('agent/computer/connector-loop-live'));
        ids.push(id);
      }
      return ids;
    },
  };
}

/** Keeps the log from growing without bound: past 5 MB it becomes `.1`. */
export async function rotateLoopLog(): Promise<void> {
  const size = (await stat(loopLogPath()).catch(quiet('agent/computer/connector-loop-live')))?.size ?? 0;
  if (size > 5_000_000) await rename(loopLogPath(), `${loopLogPath()}.1`).catch(quiet('agent/computer/connector-loop-live'));
}

export async function tailLog(lines: number): Promise<string[]> {
  try { return (await readFile(loopLogPath(), 'utf8')).split('\n').filter(Boolean).slice(-lines); } catch { return []; }
}
