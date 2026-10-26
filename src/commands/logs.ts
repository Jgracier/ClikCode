/** `clikcode logs`: the lifecycle log (runtime/lifecycle-log.ts) read back --
 * every window, worker, bridge and command, in order, as lines a person can
 * read, or as the JSON records with --json. */
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import { lifecycleLogPath } from '../runtime/lifecycle-log.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { formatLatencyTable, medianLatencyByHarness, turnsLatency } from '../runtime/turn-latency.js';
import { formatHealth, healthReport } from './logs-check.js';

interface LogsOptions { session?: string; role?: string; since?: string; lines?: string; follow?: boolean; latency?: boolean; last?: string; check?: boolean }

type Entry = Record<string, unknown> & { t: string; pid: number; role: string; event: string; session?: string };

/** `10m`, `2h`, `30s`, `1d` before now; undefined for anything else. */
export function sinceCutoff(since: string | undefined, now = Date.now()): number | undefined {
  const match = since ? /^(\d+)\s*([smhd])$/.exec(since.trim()) : null;
  if (!match) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return now - Number(match[1]) * unit;
}

export function matches(entry: Entry, options: LogsOptions, cutoff: number | undefined): boolean {
  if (options.session && !(entry.session ?? '').startsWith(options.session)) return false;
  if (options.role && entry.role !== options.role) return false;
  if (cutoff !== undefined && Date.parse(entry.t) < cutoff) return false;
  return true;
}

/** One record as a line: time, role and pid, conversation, event, facts. */
export function formatEntry(entry: Entry): string {
  const { t, pid, role, session, event, ...facts } = entry;
  const time = t.slice(11, 23);
  const details = Object.entries(facts).map(([key, value]) => `${key}=${typeof value === 'string' && !/\s/.test(value) ? value : JSON.stringify(value)}`).join(' ');
  return `${time} ${role.padEnd(7)} ${String(pid).padStart(7)} ${session ? session.slice(0, 8) : '--------'} ${event}${details ? `  ${details}` : ''}`;
}

function parse(line: string): Entry | undefined {
  try {
    const value = JSON.parse(line) as Entry;
    return typeof value.event === 'string' && typeof value.t === 'string' ? value : undefined;
  } catch { return undefined; }
}

/** The end of a log, so the default hundred lines do not read both rotated
 * files (about 20 MB) into one string. A cut line at the start is dropped. */
function readTail(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(Math.max(0, text.indexOf('\n') + 1)) : text;
  } finally { closeSync(fd); }
}

export async function showLogs(options: LogsOptions): Promise<void> {
  const path = lifecycleLogPath();
  const json = isJsonDefaultMode();
  // A check reads a day by default: what is wrong shows over hours, not over the last hundred lines.
  const cutoff = sinceCutoff(options.since ?? (options.check ? '24h' : undefined));
  const limit = Math.max(1, Number.parseInt(options.lines ?? '100', 10) || 100);
  const print = (entry: Entry): void => { process.stdout.write(`${json ? JSON.stringify(entry) : formatEntry(entry)}\n`); };
  // --since and --latency need the window. The default asks for the last
  // lines, which are at the end of the current file.
  const wantAll = Boolean(options.since || options.latency || options.check);
  const text = wantAll
    ? [`${path}.1`, path].filter((file) => existsSync(file)).map((file) => readFileSync(file, 'utf8')).join('')
    : `${readTail(`${path}.1`, 256 * 1024)}${readTail(path, 512 * 1024)}`;
  const entries = text.split('\n').map(parse).filter((entry): entry is Entry => Boolean(entry) && matches(entry!, options, cutoff));
  if (!entries.length && !options.follow) {
    process.stderr.write(existsSync(path) ? 'No lifecycle records match.\n' : `No lifecycle log yet (${path}).\n`);
  }
  if (options.check) {
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
    const report = healthReport(entries, alive);
    process.stdout.write(`${json ? JSON.stringify(report) : formatHealth(report)}\n`);
    return;
  }
  if (options.latency) {
    // Where each turn's time went: the marks of the turns, newest --last N.
    const last = Math.max(1, Number.parseInt(options.last ?? '20', 10) || 20);
    const turns = turnsLatency(entries.filter((entry) => entry.event === 'turn.mark')).slice(-last);
    process.stdout.write(`${json ? JSON.stringify({ turns, medians: medianLatencyByHarness(turns) }) : formatLatencyTable(turns)}\n`);
    return;
  }
  for (const entry of entries.slice(-limit)) print(entry);
  if (!options.follow) return;
  // Follow: read what is appended, as it is appended.
  let offset = existsSync(path) ? statSync(path).size : 0;
  let carry = '';
  const readNew = (): void => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const stream = createReadStream(path, { start: offset, end: size - 1, encoding: 'utf8' });
    offset = size;
    stream.on('data', (chunk) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const entry = parse(line);
        if (entry && matches(entry, options, cutoff)) print(entry);
      }
    });
  };
  await new Promise<void>(() => {
    watch(lifecycleLogPath().replace(/lifecycle\.log$/, ''), () => readNew());
    setInterval(readNew, 2_000);
  });
}
