/** React to measured memory pressure. A probe owns the platform-specific
 * accounting and stop operation; this controller only chooses and informs. */
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import { cgroupProbe, processProbe, type Inventory, type MemorySample, type Probe, type Unit } from './resource-probes.js';

const GIB = 2 ** 30;
const TICK_MS = 2_000;
export const NUDGE_AT = 0.85;
export const NUDGE_REARM_BELOW = 0.75;
export const SETTLE_MS = 15_000;
const STOP_INTERVAL_MS = 20_000;
const EFFECTIVE_SHARE = 0.25;
const SLICE_CEILING_SHARE = 0.97;

export interface AgentBudget { used: number; limit: number; ratio: number }
export function desktopReserve(total: number): number { return Math.max(4 * GIB, total * 0.08); }
export function agentBudget(sample: MemorySample): AgentBudget {
  const byMachine = sample.used + sample.available - desktopReserve(sample.total);
  const bySlice = sample.ceiling ? sample.ceiling * SLICE_CEILING_SHARE : Infinity;
  const limit = Math.max(0, Math.min(byMachine, bySlice));
  const ratio = limit > 0 ? sample.used / limit : Infinity;
  return { used: sample.used, limit, ratio: sample.critical ? Math.max(ratio, 1) : ratio };
}

export function worthStopping(unit: Unit, budget: AgentBudget): boolean {
  return unit.freeable >= Math.max(GIB, budget.limit * 0.03);
}
export type GuardAction = { kind: 'none' } | { kind: 'nudge'; worker: number; unit?: Unit } | { kind: 'stop'; worker: number; unit: Unit };
/** Only a measured unit large enough to relieve pressure is stopped. */
export function decideAction(budget: AgentBudget, inventory: Inventory): GuardAction {
  if (budget.ratio < NUDGE_AT || !inventory.workers.length) return { kind: 'none' };
  const bySize = [...inventory.units].sort((a, b) => b.freeable - a.freeable);
  const commands = bySize.filter((unit) => unit.kind === 'command' && unit.owner !== undefined);
  if (budget.ratio >= 1) {
    const command = commands.find((unit) => worthStopping(unit, budget));
    if (command) return { kind: 'stop', worker: command.owner!, unit: command };
  }
  const largest = commands[0];
  if (!largest) return { kind: 'nudge', worker: Math.min(...inventory.workers) };
  // A command too small to stop is not named. Naming an 8 MB sleep sent the
  // agent after the wrong thing (2026-10-13).
  return worthStopping(largest, budget)
    ? { kind: 'nudge', worker: largest.owner!, unit: largest }
    : { kind: 'nudge', worker: largest.owner! };
}
const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;
export function nudgeNote(budget: AgentBudget, conversations: number, unit?: Unit): string {
  return [
    `Memory is getting tight: agents are using ${gb(budget.used)} of ${gb(budget.limit)} available to them across ${conversations} conversation${conversations === 1 ? '' : 's'}.`,
    unit ? `Your \`${unit.label}\` holds about ${gb(unit.freeable)}.` : '',
    'Prefer targeted tests and fewer parallel workers before starting more heavy work.',
  ].filter(Boolean).join(' ');
}
export function stopNote(budget: AgentBudget, conversations: number, unit: Unit, platform: NodeJS.Platform = process.platform): string {
  const how = platform === 'win32' ? 'terminated by ClikCode (taskkill)' : 'killed by ClikCode (SIGKILL)';
  return `ClikCode stopped \`${unit.label}\` and its child processes because it held about ${gb(unit.freeable)} while agents used ${gb(budget.used)} of ${gb(budget.limit)} across ${conversations} conversations. It was ${how} for resource pressure, not a test failure. Use targeted tests, fewer workers, or smaller runs; do not rerun the same command unchanged.`;
}
function marker(): string { return join(stateDirectory(), 'resource-guard.last-stop'); }
function ineffectiveMarker(): string { return join(stateDirectory(), 'resource-guard.ineffective'); }
function lastStopAt(): number { try { return Number(readFileSync(marker(), 'utf8')) || 0; } catch { return 0; } }
function ineffective(): boolean { try { return readFileSync(ineffectiveMarker(), 'utf8').length > 0; } catch { return false; } }
/** Set when /tmp is a RAM disk holding enough to matter. Stopping a command does not free it. */
export function ramTmpNote(): string {
  try {
    if (!/^tmpfs \/tmp /m.test(readFileSync('/proc/mounts', 'utf8'))) return '';
    const stat = statfsSync('/tmp');
    const used = Number(stat.bsize) * (Number(stat.blocks) - Number(stat.bavail));
    if (!(used >= 4 * GIB)) return '';
    return ` /tmp is RAM here and holds about ${gb(used)}; deleting those files frees memory, stopping a command does not.`;
  } catch { return ''; }
}

export interface ResourceGuardOptions {
  sessionId: string;
  sliceDir?: string;
  /** This worker's command names, kept after the shell process exits. */
  remembered?: { scopeDir: string; labels: ReadonlyMap<string, string> };
  deliver: (note: string) => void;
  probe?: Probe;
}
/** When a Linux scope isn't delegated, or on macOS/Windows, use the process
 * probe. It is approximate and has no orphan cleanup; its stop implementation
 * revalidates the root before signalling. */
export function startResourceGuard(options: ResourceGuardOptions): () => void {
  const { sessionId, deliver } = options;
  const probe = options.probe ?? (options.sliceDir ? cgroupProbe(options.sliceDir, options.remembered) : processProbe());
  let nudged = false;
  let pending: { unit: Unit; before: number; at: number } | undefined;
  const tick = async (): Promise<void> => {
    const sample = await probe.sample();
    if (!sample) return;
    const budget = agentBudget(sample);
    if (pending && Date.now() - pending.at >= SETTLE_MS) {
      const freed = pending.before - budget.used;
      const effective = freed >= pending.unit.freeable * EFFECTIVE_SHARE;
      lifecycle('resource.effect', { session: sessionId, label: pending.unit.label, held: pending.unit.freeable, freed, effective });
      // If stopping something did not help, the cause is outside measured
      // commands (e.g. /tmp, an orphan, agent machinery). No more kills this
      // pressure episode; resume only after memory has recovered.
      if (!effective) writeFileSync(ineffectiveMarker(), String(Date.now()));
      pending = undefined;
    }
    if (budget.ratio < NUDGE_REARM_BELOW) {
      nudged = false;
      try { rmSync(ineffectiveMarker(), { force: true }); } catch { /* fail-open-ok */ }
    }
    if (budget.ratio < NUDGE_AT || Date.now() - lastStopAt() < STOP_INTERVAL_MS || pending) return;
    const inventory = await probe.inventory();
    const action = decideAction(budget, inventory);
    if (action.kind === 'none' || action.worker !== process.pid) return;
    const conversations = inventory.workers.length;
    if (action.kind === 'stop' && !ineffective()) {
      if (!await probe.stop(action.unit.target)) return;
      try { mkdirSync(stateDirectory(), { recursive: true }); writeFileSync(marker(), String(Date.now())); } catch { /* fail-open-ok */ }
      pending = { unit: action.unit, before: budget.used, at: Date.now() };
      lifecycle('resource.stop', { session: sessionId, kind: action.unit.kind, label: action.unit.label, held: action.unit.freeable, used: budget.used, limit: budget.limit });
      if (action.unit.kind === 'command') deliver(stopNote(budget, conversations, action.unit) + ramTmpNote());
    } else if (!nudged) {
      nudged = true;
      lifecycle('resource.nudge', { session: sessionId, ...(action.unit ? { label: action.unit.label, held: action.unit.freeable } : {}), used: budget.used, limit: budget.limit });
      deliver(nudgeNote(budget, conversations, action.unit) + ramTmpNote());
    }
  };
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick().catch((error) => lifecycle('resource.error', { session: sessionId, message: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
