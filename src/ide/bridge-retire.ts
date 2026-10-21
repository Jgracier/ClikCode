/** The editor's bridge giving way to a newer ClikCode build, as a session
 * worker does (worker/worker-idle.ts leaveIfStaleBuild).
 *
 * A bridge lives as long as its editor's connection: VS Code's shared
 * process for the whole window, ClikCode Remote's SSH connection for as long
 * as a remote chat is open. Without this it went on serving `open`, `send`
 * and every slash command with the code it started with long after an update
 * installed another -- the fix just installed did not run, while a worker it
 * started ran the new code.
 *
 * So it records its build at start and looks again every BUILD_WATCH_MS.
 * Once the installed build differs it leaves, but only while quiet: nothing
 * it was asked is still being answered, no turn it relays or follows is
 * running, no picker or sign-in is open, and nothing has happened for
 * RETIRE_QUIET_MS. Leaving says so first (`retiring` / `host-retiring`), so
 * the client reconnects at once and re-opens the same chat on the new build
 * instead of showing an error. */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { BUILD_WATCH_MS, RETIRE_QUIET_MS } from '../worker/build-retire.js';
import { currentWorkerBuild } from '../worker/registry.js';

/** The lifecycle log's reason for a bridge that left for a newer build. */
export const BRIDGE_RETIRE_REASON = 'replaced by a newer ClikCode build';

export interface BridgeRetireOptions {
  /** What holds the bridge where it is (undefined: nothing does). */
  blocker(): string | undefined;
  /** When anything last happened in it (ms since the epoch). */
  lastActivityAt(): number;
  /** Leave: tell the client, close every chat, exit. Called once. */
  retire(): void;
  /** The build this process started with; currentWorkerBuild() at start by default. */
  startBuild?: string | undefined;
  currentBuild?: () => string | undefined;
  watchMs?: number;
  quietMs?: number;
  now?: () => number;
}

export interface BridgeRetireWatch {
  /** Looks now (the timer looks every watchMs). */
  check(): void;
  stop(): void;
}

export function watchForNewerBuild(options: BridgeRetireOptions): BridgeRetireWatch {
  const startBuild = 'startBuild' in options ? options.startBuild : currentWorkerBuild();
  const currentBuild = options.currentBuild ?? currentWorkerBuild;
  const quietMs = options.quietMs ?? RETIRE_QUIET_MS;
  const now = options.now ?? Date.now;
  let done = false;
  let held = '';
  const note = (state: string): void => {
    if (state === held) return;
    held = state;
    lifecycle('bridge.retire.wait', { state });
  };
  const check = (): void => {
    if (done || !startBuild) return;
    const live = currentBuild();
    // An entry that cannot be read (mid-install) is not a new build yet.
    if (!live || live === startBuild) return;
    const blocker = options.blocker();
    if (blocker) { note(`held: ${blocker}`); return; }
    const quietFor = now() - options.lastActivityAt();
    if (quietFor < quietMs) { note('held: leaving for the newer build once it is quiet'); return; }
    done = true;
    clearInterval(timer);
    lifecycle('bridge.retire', { reason: BRIDGE_RETIRE_REASON });
    options.retire();
  };
  const timer = setInterval(check, options.watchMs ?? BUILD_WATCH_MS);
  timer.unref();
  return { check, stop: () => { done = true; clearInterval(timer); } };
}
