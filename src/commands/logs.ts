/** `clikcode logs`: the lifecycle log (runtime/lifecycle-log.ts) read back --
 * every window, worker, bridge and command, in order, as lines a person can
 * read, or as the JSON records with --json. */
import { createReadStream, existsSync, readFileSync, statSync, watch } from 'node:fs';
import { lifecycleLogPath } from '../runtime/lifecycle-log.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';

export interface LogsOptions { session?: string; role?: string; since?: string; lines?: string; follow?: boolean }

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

export async function showLogs(options: LogsOptions): Promise<void> {
  const path = lifecycleLogPath();
  const json = isJsonDefaultMode();
  const cutoff = sinceCutoff(options.since);
  const limit = Math.max(1, Number.parseInt(options.lines ?? '100', 10) || 100);
  const print = (entry: Entry): void => { process.stdout.write(`${json ? JSON.stringify(entry) : formatEntry(entry)}\n`); };
  // The rotated file first: a --since reaching back past a rotation still
  // finds what it is asking for.
  const text = [`${path}.1`, path].filter((file) => existsSync(file)).map((file) => readFileSync(file, 'utf8')).join('');
  const entries = text.split('\n').map(parse).filter((entry): entry is Entry => Boolean(entry) && matches(entry!, options, cutoff));
  if (!entries.length && !options.follow) {
    process.stderr.write(existsSync(path) ? 'No lifecycle records match.\n' : `No lifecycle log yet (${path}).\n`);
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
