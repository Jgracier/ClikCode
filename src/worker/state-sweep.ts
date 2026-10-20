/** ClikCode cleans up what it leaves under its own state directory, so that
 * nothing it writes grows without bound and no other tool has to know about it.
 *
 * - `t/<conversation>/`: the temp directory every worker and everything its
 *   agent runs writes into (conversation-tmp.ts). MEASURED 2026-10-14: 2.4 GB
 *   and ~1,500 entries after a day of one agent's build loop, nothing ever
 *   removed. Entries older than three days go, unless a live process has one
 *   open or as its working directory (Linux, where /proc says so); where that
 *   cannot be told, only entries older than a week go. The conversation
 *   directories themselves stay: a tool that creates its temp file there
 *   fails if the directory is gone.
 * - `resource-notes/`: notes held for a next turn that never came. Advice
 *   from a week ago about memory is not advice.
 *
 * It does not touch anything it did not make: vendor profiles, chat history,
 * and downloaded models are the user's. A sweep runs shortly after a worker
 * starts and every six hours; a marker keeps workers that start together from
 * all sweeping. */
import { readdirSync, readlinkSync } from 'node:fs';
import { lstat, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TMP_MAX_AGE_MS = 3 * DAY_MS;
/** When nothing can say whether a process is still using an entry. */
export const TMP_MAX_AGE_BLIND_MS = 7 * DAY_MS;
export const NOTE_MAX_AGE_MS = 7 * DAY_MS;
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SWEEP_MIN_GAP_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60_000;

/** Every path under `root` that a live process has open or as its working
 * directory; undefined where /proc cannot say (macOS, Windows). Processes of
 * other users are not visible, which errs toward removing -- only ever
 * something already three days old. */
export function pathsInUse(root: string): string[] | undefined {
  let pids: string[];
  try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return undefined; }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const found = new Set<string>();
  const check = (link: string): void => {
    try {
      const target = readlinkSync(link);
      if (target.startsWith(prefix)) found.add(target);
    } catch { /* fail-open-ok: the process exited, or is not ours to see */ }
  };
  for (const pid of pids) {
    check(`/proc/${pid}/cwd`);
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) check(`/proc/${pid}/fd/${fd}`); } catch { /* fail-open-ok: same */ }
  }
  return [...found];
}

function inUse(used: readonly string[], entry: string): boolean {
  return used.some((path) => path === entry || path.startsWith(`${entry}${sep}`));
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
  } catch { return []; }
}

async function ageMs(path: string, now: number): Promise<number | undefined> {
  try { return now - (await lstat(path)).mtimeMs; } catch { return undefined; }
}

interface SweepOptions {
  now?: number;
  /** Test seam: what is in use under a root. */
  used?: (root: string) => string[] | undefined;
  /** Sweep even if one ran within the hour. */
  force?: boolean;
}

export async function sweepState(options: SweepOptions = {}): Promise<{ ran: boolean; removed: number }> {
  const now = options.now ?? Date.now();
  const home = stateDirectory();
  const marker = join(home, 'state-sweep.last');
  const last = await ageMs(marker, now);
  if (!options.force && last !== undefined && last < SWEEP_MIN_GAP_MS) return { ran: false, removed: 0 };
  try {
    await writeFile(marker, String(now));
    await utimes(marker, new Date(now), new Date(now));
  } catch { return { ran: false, removed: 0 }; }

  let removed = 0;
  const remove = async (path: string): Promise<void> => {
    try { await rm(path, { recursive: true, force: true }); removed += 1; } catch { /* fail-open-ok: in use or already gone; the next sweep tries again */ }
  };

  const tmpRoot = join(home, 't');
  const used = (options.used ?? pathsInUse)(tmpRoot);
  const maxAge = used ? TMP_MAX_AGE_MS : TMP_MAX_AGE_BLIND_MS;
  for (const conversation of await directories(tmpRoot)) {
    const dir = join(tmpRoot, conversation);
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      const entry = join(dir, name);
      const age = await ageMs(entry, now);
      if (age === undefined || age < maxAge) continue;
      if (used && inUse(used, entry)) continue;
      await remove(entry);
    }
  }

  const notesRoot = join(home, 'resource-notes');
  try {
    for (const name of await readdir(notesRoot)) {
      const age = await ageMs(join(notesRoot, name), now);
      if (age !== undefined && age >= NOTE_MAX_AGE_MS) await remove(join(notesRoot, name));
    }
  } catch { /* fail-open-ok: no notes were ever held */ }

  lifecycle('state.sweep', { removed });
  return { ran: true, removed };
}

/** The sweep on its schedule. Returns what stops it. */
export function startStateSweep(): () => void {
  const run = (): void => {
    void sweepState().catch((error: unknown) => lifecycle('state.sweep.error', { message: error instanceof Error ? error.message : String(error) }));
  };
  const first = setTimeout(run, FIRST_SWEEP_DELAY_MS);
  const every = setInterval(run, SWEEP_INTERVAL_MS);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
