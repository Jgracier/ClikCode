/** Tell an open conversation list that something it shows may have changed.
 *
 * What the list draws comes from three places on disk: the index (titles,
 * dates), the session files (a turn's `pendingTurn`), and the worker
 * registry (which chats have a process). Watching those directories replaces
 * re-reading them on a timer while a row spins: a turn starting or ending, or
 * a worker exiting, writes one of them.
 *
 * A streaming turn rewrites its session file several times a second, so
 * changes are coalesced: the first change in a quiet period is reported
 * after `debounceMs`, and never more often than once per `minIntervalMs`.
 *
 * fs.watch is not available everywhere (some network and container
 * filesystems, an exhausted inotify limit). When a directory cannot be
 * watched, the list falls back to a slow poll -- `fallbackMs` -- rather than
 * going stale. */

import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import { sessionsDirectory, stateDirectory } from './store/paths.js';
import { workersDirectory } from '../worker/registry.js';

export interface ListWatch {
  /** False when it fell back to polling. */
  readonly watching: boolean;
  stop(): void;
}

export interface ListWatchOptions {
  debounceMs?: number;
  minIntervalMs?: number;
  fallbackMs?: number;
  /** The directories to watch, first one the parent of the rest: a caller
   * that needs only some (a prompt watching the worker registry), or a test. */
  directories?: readonly string[];
}

export function watchConversationList(onChange: () => void, options: ListWatchOptions = {}): ListWatch {
  const debounceMs = options.debounceMs ?? 150;
  const minIntervalMs = options.minIntervalMs ?? 1_000;
  const fallbackMs = options.fallbackMs ?? 10_000;
  const [root, ...children] = options.directories ?? [stateDirectory(), sessionsDirectory(), workersDirectory()];
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let lastFired = 0;

  const fire = (): void => {
    timer = undefined;
    if (stopped) return;
    lastFired = Date.now();
    onChange();
  };
  const changed = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(fire, Math.max(debounceMs, lastFired + minIntervalMs - Date.now()));
    timer.unref?.();
  };
  const fallBack = (): void => {
    if (stopped || poll) return;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    poll = setInterval(() => { if (!stopped) onChange(); }, fallbackMs);
    poll.unref?.();
  };
  /** Watch one directory. A missing one is not a failure: the root's watcher
   * sees it created and attaches then. */
  const attach = (directory: string, listener: (name: string | null) => void): boolean => {
    if (poll || watchers.has(directory)) return true;
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => listener(name === null ? null : String(name)));
      watcher.on('error', fallBack);
      watchers.set(directory, watcher);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && directory !== root;
    }
  };
  const attachChildren = (): boolean => children.every((directory) => attach(directory, changed));
  const childNames = new Set(children.map((directory) => basename(directory)));
  const onRoot = (name: string | null): void => {
    // The state directory holds more than the list reads (logs, caches):
    // only the index (replaced by rename) and the directories above matter.
    if (name !== null && !name.startsWith('index') && !childNames.has(name)) return;
    if (!attachChildren()) fallBack();
    changed();
  };
  if (!root || !attach(root, onRoot) || !attachChildren()) fallBack();

  return {
    get watching() { return !poll; },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
