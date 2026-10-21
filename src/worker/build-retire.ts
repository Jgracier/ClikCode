/** When a process running an older ClikCode build gives way to the newly
 * installed one: how often it looks, and how long it must have been quiet.
 * Shared by the session worker (worker-idle.ts) and the editor's bridge
 * (ide/bridge-retire.ts), so both swap builds on the same terms. Kept free of
 * imports: the bridge reads it without loading the worker. */

/** How often an idle process checks whether a rebuild replaced its entry
 * (registry.ts currentWorkerBuild). CLIKCODE_WORKER_BUILD_WATCH_MS overrides it for tests. */
export const BUILD_WATCH_MS = Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) > 0 ? Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) : 15_000;

/** A newer build replaces a process only after this long with nothing happening in it: no turn,
 * no vendor activity, no window coming or going, no request from its editor. The vendor works in
 * bursts -- out of turn, after a background task ends -- with gaps between them that look idle,
 * and a window reload is a disconnect of a second; retiring in either cut a running turn off.
 * Replacing is silent: the next client to need it starts or attaches to the new build.
 * CLIKCODE_WORKER_RETIRE_QUIET_MS overrides it for tests (0 is allowed). */
export const RETIRE_QUIET_MS = Number(process.env.CLIKCODE_WORKER_RETIRE_QUIET_MS) >= 0 && process.env.CLIKCODE_WORKER_RETIRE_QUIET_MS
  ? Number(process.env.CLIKCODE_WORKER_RETIRE_QUIET_MS) : 30_000;
