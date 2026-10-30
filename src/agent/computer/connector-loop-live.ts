/** The real ports of the connector loop: ClikDeploy's queue through its CLI, the ClikCode browser in one named tab per vendor, /proc/pressure, the
 * log (~/.clikcode/connector-loop.log) and the state file the `connectors status` command reads. */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quiet } from '../../runtime/lifecycle-log.js';
import type { DeployClient, HumanStep } from './connector-runner.js';
import { runVendor } from './connector-runner.js';
import { budgeted, stalledBy, tabName, type LoopPorts, type LoopState, type WorkContext } from './connector-loop.js';
import { liveDriver, WORKER } from './connector-runner-live.js';
import { microTab } from './connector-micro-agent.js';

export const loopDir = (): string => join(homedir(), '.clikcode');
export const loopLogPath = (): string => join(loopDir(), 'connector-loop.log');
export const loopStatePath = (): string => join(loopDir(), 'connector-loop.json');

export async function readLoopState(): Promise<LoopState | undefined> {
  try { return JSON.parse(await readFile(loopStatePath(), 'utf8')) as LoopState; } catch { return undefined; }
}
export const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** The queue rows worth claiming: waiting for an agent, with no other worker's live lease. */
export function claimable(rows: Array<Record<string, unknown>>, exclude: ReadonlySet<string>, nowMs: number, n: number): string[] {
  return rows.filter(r => typeof r.id === 'string' && r.stage === 'needs-agent' && !exclude.has(r.id as string)
    && !(typeof r.leaseUntil === 'string' && Date.parse(r.leaseUntil) > nowMs && r.leaseHolder && !String(r.leaseHolder).includes(WORKER))).map(r => r.id as string).slice(0, Math.max(n, 0) * 4);
}

export function livePorts(client: DeployClient, stateDir: string, extra: { stopRequested: () => boolean }): LoopPorts {
  const append = async (line: string): Promise<void> => { await mkdir(loopDir(), { recursive: true }); await appendFile(loopLogPath(), `${line}\n`, { mode: 0o600 }); };
  return {
    pid: process.pid,
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stopRequested: extra.stopRequested,
    log: line => { void append(line).catch(quiet('agent/computer/connector-loop-live')); },
    async next(n, exclude) {
      const data = await client.tool('connector_work_overview', { stage: 'needs-agent', limit: 100 }) as { rows?: Array<Record<string, unknown>> };
      const got: Array<{ id: string }> = [];
      for (const id of claimable(data.rows ?? [], exclude, Date.now(), n)) {
        if (got.length >= n) break;
        const claim = await client.tool('connector_work_claim', { id, stage: 'needs-agent', worker: WORKER }).catch(() => null) as { id?: string } | null;
        if (claim && claim.id === id) got.push({ id });
      }
      return got;
    },
    async renew(id) { await client.tool('connector_work_renew', { id, worker: WORKER }); },
    async work(id, ctx: WorkContext) {
      const counted = budgeted(client, ctx.budget);
      const driver = liveDriver({ stateDir, tab: ctx.tab, keepBrowser: true });
      const first = await counted.onboard(id);
      const { limits } = ctx;
      return runVendor(first, counted, driver, { maxSteps: limits.maxSteps, maxMs: Math.max(30_000, ctx.deadline - Date.now()), agentCalls: 25, log: line => void append(`${new Date().toISOString()} id=${id} ${line}`).catch(quiet('agent/computer/connector-loop-live')) }, job => job());
    },
    async report(id, report) {
      await client.report({ id, outcome: report.outcome, reason: report.reason, ...(report.humanStep ? { humanStep: report.humanStep as HumanStep } : {}) });
    },
    async pressure() {
      const read = (name: string): Promise<string | undefined> => readFile(`/proc/pressure/${name}`, 'utf8').catch(() => undefined);
      return stalledBy(await read('io'), await read('cpu'), 10);
    },
    async closeTab(id) {
      const { closeComputerPage } = await import('./browser.js');
      await closeComputerPage(stateDir, tabName(id)).catch(quiet('agent/computer/connector-loop-live'));
      await closeComputerPage(stateDir, microTab(id)).catch(quiet('agent/computer/connector-loop-live'));
    },
    async restartBrowser() { await (await import('./browser.js')).closeComputerBrowser(stateDir); },
    async saveState(state) {
      await mkdir(loopDir(), { recursive: true });
      const tmp = `${loopStatePath()}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
      await rename(tmp, loopStatePath());
    },
    async loadCooldown() { return (await readLoopState())?.cooldown; },
  };
}

/** Keeps the log from growing without bound: past 5 MB it becomes `.1`. */
export async function rotateLoopLog(): Promise<void> {
  const size = (await stat(loopLogPath()).catch(() => undefined))?.size ?? 0;
  if (size > 5_000_000) await rename(loopLogPath(), `${loopLogPath()}.1`).catch(quiet('agent/computer/connector-loop-live'));
}

export async function tailLog(lines: number): Promise<string[]> {
  try { return (await readFile(loopLogPath(), 'utf8')).split('\n').filter(Boolean).slice(-lines); } catch { return []; }
}
