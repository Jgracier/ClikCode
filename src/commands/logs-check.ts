/** `clikcode logs --check`: the lifecycle log read for what is wrong, instead of for what happened.
 *
 * The questions asked by hand after the fact -- which command keeps failing and who starts it,
 * which tool calls fail and whose they are, where errors are being swallowed, which processes
 * died without a word, is the disk slowing the state files -- answered in one place from the
 * records the log already holds. Findings are sentences; the numbers behind them are in the
 * report, and `--json` prints it whole. */

export interface HealthEntry { t: string; pid: number; role: string; event: string; [field: string]: unknown }

export interface HealthReport {
  window: { from?: string; to?: string; entries: number };
  processes: { started: number; exited: number; abnormal: Array<{ what: string; code: number; parent?: string; count: number }>; signals: Record<string, number>; vanished: number };
  retiredLaunches: Array<{ command: string; parent?: string; count: number }>;
  tools: { total: number; failed: number; failures: Array<{ name: string; child: boolean; count: number; sample?: string }> };
  swallowed: Array<{ area: string; count: number; errno?: string; sample?: string }>;
  children: Array<{ program: string; how: string; count: number }>;
  turns: { outcomes: Record<string, number>; attemptFailures: Record<string, number> };
  state: { slowWrites: number; worstWriteMs: number; worstLockHeldMs: number };
  crashes: Record<string, number>;
  findings: string[];
}

const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const bump = <K extends string>(map: Map<K, number>, key: K, by = 1): void => { map.set(key, (map.get(key) ?? 0) + by); };
const top = <T>(items: T[], count: number, by: (item: T) => number): T[] => items.sort((a, b) => by(b) - by(a)).slice(0, count);

/** `alive` says whether a pid still runs: a start with no exit is only a finding when it does not. */
export function healthReport(entries: readonly HealthEntry[], alive: (pid: number) => boolean = () => true, now = Date.now()): HealthReport {
  const starts = new Map<number, HealthEntry>();
  const exited = new Set<number>();
  const abnormal = new Map<string, { what: string; code: number; parent?: string; count: number }>();
  const retired = new Map<string, { command: string; parent?: string; count: number }>();
  const failures = new Map<string, { name: string; child: boolean; count: number; sample?: string }>();
  const swallowed = new Map<string, { area: string; count: number; errno?: string; sample?: string }>();
  const children = new Map<string, { program: string; how: string; count: number }>();
  const outcomes = new Map<string, number>();
  const attemptFailures = new Map<string, number>();
  const crashes = new Map<string, number>();
  const signals = new Map<string, number>();
  let tools = 0; let toolsFailed = 0; let slowWrites = 0; let worstWrite = 0; let worstLock = 0; let started = 0; let exits = 0;

  for (const entry of entries) {
    switch (entry.event) {
      case 'process.start': started += 1; starts.set(entry.pid, entry); break;
      case 'process.exit': {
        exits += 1; exited.add(entry.pid);
        const code = n(entry.code);
        if (code === 0) break;
        const start = starts.get(entry.pid);
        const what = text(entry.argv) ?? text(start?.argv) ?? entry.role;
        const parent = text(entry.parent) ?? text(start?.parent);
        const key = `${what}|${code}|${parent ?? ''}`;
        const seen = abnormal.get(key) ?? { what, code, ...(parent ? { parent } : {}), count: 0 };
        seen.count += 1; abnormal.set(key, seen);
        break;
      }
      case 'process.signal': exited.add(entry.pid); bump(signals, `${text(entry.signal) ?? 'signal'} ${text(entry.argv) ?? entry.role}`.trim()); break;
      case 'process.error': bump(crashes, text(entry.errno) ?? text(entry.origin) ?? 'error'); break;
      case 'mcp.retired.launch': {
        const command = text(entry.command) ?? '?'; const parent = text(entry.parent);
        const key = `${command}|${parent ?? ''}`;
        const seen = retired.get(key) ?? { command, ...(parent ? { parent } : {}), count: 0 };
        seen.count += 1; retired.set(key, seen);
        break;
      }
      case 'turn.tool': {
        tools += 1;
        if (entry.ok !== false) break;
        toolsFailed += 1;
        const name = text(entry.name) ?? 'tool'; const child = entry.child === true;
        const key = `${name}|${child}`;
        const seen = failures.get(key) ?? { name, child, count: 0 };
        seen.count += 1; if (!seen.sample && text(entry.err)) seen.sample = text(entry.err);
        failures.set(key, seen);
        break;
      }
      case 'swallowed': {
        const area = text(entry.area) ?? '?';
        const seen = swallowed.get(area) ?? { area, count: 0 };
        seen.count += 1 + n(entry.more);
        if (!seen.errno && text(entry.errno)) seen.errno = text(entry.errno);
        if (!seen.sample && text(entry.message)) seen.sample = text(entry.message);
        swallowed.set(area, seen);
        break;
      }
      case 'child.failed': {
        const program = text(entry.program) ?? '?';
        const how = text(entry.errno) ?? (entry.signal ? `signal ${String(entry.signal)}` : `exit ${n(entry.code)}`);
        const key = `${program}|${how}`;
        const seen = children.get(key) ?? { program, how, count: 0 };
        seen.count += 1 + n(entry.more); children.set(key, seen);
        break;
      }
      case 'worker.turn.end': bump(outcomes, (text(entry.outcome) ?? '?').replace(/^error:.*/, 'error')); break;
      case 'worker.turn.attempt-failed': bump(attemptFailures, text(entry.kind) ?? 'other'); break;
      case 'state.write.slow': slowWrites += 1; worstWrite = Math.max(worstWrite, n(entry.ms)); break;
      case 'lock.held': worstLock = Math.max(worstLock, n(entry.ms)); break;
      default: break;
    }
  }

  const vanished = [...starts.values()].filter((start) => !exited.has(start.pid) && now - Date.parse(start.t) > 60_000 && !alive(start.pid)).length;
  const report: HealthReport = {
    window: { ...(entries[0] ? { from: entries[0].t } : {}), ...(entries.at(-1) ? { to: entries.at(-1)!.t } : {}), entries: entries.length },
    processes: { started, exited: exits, abnormal: top([...abnormal.values()], 8, (item) => item.count), signals: Object.fromEntries(signals), vanished },
    retiredLaunches: top([...retired.values()], 8, (item) => item.count),
    tools: { total: tools, failed: toolsFailed, failures: top([...failures.values()], 8, (item) => item.count) },
    swallowed: top([...swallowed.values()], 10, (item) => item.count),
    children: top([...children.values()], 8, (item) => item.count),
    turns: { outcomes: Object.fromEntries(outcomes), attemptFailures: Object.fromEntries(attemptFailures) },
    state: { slowWrites, worstWriteMs: worstWrite, worstLockHeldMs: worstLock },
    crashes: Object.fromEntries(crashes),
    findings: [],
  };

  const findings = report.findings;
  for (const launch of report.retiredLaunches) findings.push(`A vendor config still launches the retired \`${launch.command}\`${launch.parent ? ` (started by ${launch.parent})` : ''}: ${launch.count} time${launch.count === 1 ? '' : 's'}. It answers as an empty server now; remove its entry.`);
  for (const item of report.processes.abnormal) findings.push(`\`${item.what}\` exited ${item.code} ${item.count} time${item.count === 1 ? '' : 's'}${item.parent ? `, started by ${item.parent}` : ''}.`);
  if (report.processes.vanished) findings.push(`${report.processes.vanished} process${report.processes.vanished === 1 ? '' : 'es'} started and never said how they ended (killed with SIGKILL, or crashed hard).`);
  for (const item of report.tools.failures) if (item.count >= 3) findings.push(`${item.count} \`${item.name}\` calls failed${item.child ? ' inside a sub-agent' : ''}${item.sample ? `: ${item.sample}` : ''}.`);
  for (const item of report.swallowed) if (item.count >= 3) findings.push(`${item.count} errors swallowed in ${item.area}${item.errno ? ` (${item.errno})` : ''}${item.sample ? `: ${item.sample}` : ''}.`);
  for (const item of report.children) if (item.count >= 3) findings.push(`\`${item.program}\` failed ${item.count} times (${item.how}).`);
  if (slowWrites >= 20) findings.push(`${slowWrites} slow state writes, the worst ${worstWrite} ms.`);
  if (worstLock >= 5_000) findings.push(`The shared state lock was held for ${Math.round(worstLock / 1000)} s once.`);
  for (const [kind, count] of attemptFailures) if (kind !== 'quota-exhausted' && count >= 3) findings.push(`${count} turn attempts failed as ${kind}.`);
  return report;
}

export function formatHealth(report: HealthReport): string {
  const lines: string[] = [];
  const span = report.window.from && report.window.to ? `${report.window.from.slice(11, 19)} to ${report.window.to.slice(11, 19)} UTC` : 'no records';
  lines.push(`ClikCode log check · ${report.window.entries} records · ${span}`);
  lines.push('');
  lines.push(report.findings.length ? 'Needs attention' : 'Nothing needs attention.');
  for (const finding of report.findings) lines.push(`  - ${finding}`);
  lines.push('');
  const outcomes = Object.entries(report.turns.outcomes).map(([name, count]) => `${count} ${name}`).join(', ') || 'none';
  lines.push(`Turns: ${outcomes}`);
  lines.push(`Processes: ${report.processes.started} started, ${report.processes.exited} exited`);
  lines.push(`Tool calls: ${report.tools.total}, ${report.tools.failed} failed`);
  lines.push(`State: ${report.state.slowWrites} slow writes (worst ${report.state.worstWriteMs} ms), shared lock held at most ${report.state.worstLockHeldMs} ms`);
  const swallowed = report.swallowed.reduce((sum, item) => sum + item.count, 0);
  lines.push(`Swallowed errors: ${swallowed}${report.swallowed.length ? ` (${report.swallowed.slice(0, 3).map((item) => `${item.area} ${item.count}`).join(', ')})` : ''}`);
  const crashes = Object.entries(report.crashes).map(([name, count]) => `${count} ${name}`).join(', ');
  if (crashes) lines.push(`Uncaught errors: ${crashes}`);
  return lines.join('\n');
}
