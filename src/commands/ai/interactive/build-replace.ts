/** Switching this window to the newest installed ClikCode, on request.
 *
 * A window swaps builds by itself only when nothing is using it (window.ts): no turn, no draft, no picker. One that is always
 * working -- agents running for hours -- never is, and ran an old build all day with nothing to say so. `/restart` is the user's
 * word that now is the moment: the chat stays, and what the worker is running keeps running (the new process follows it). One
 * window per process, so the way to do it is registered here by the window and called by whoever was asked. */

type Replacer = () => Promise<void> | undefined;
let replacer: Replacer | undefined;

export function registerBuildReplacer(next: Replacer | undefined): void { replacer = next; }

/** Leaves for the newest build: a promise that ends with this process, or undefined when this window already runs it. */
export function replaceWindowBuild(): Promise<void> | undefined { return replacer?.(); }

/** How long a newer build may wait for a window that is never idle before it is told. */
export const STALE_BUILD_NOTICE_MS = 10 * 60_000;

/** Whether to say now that a newer build is installed and this window is still on the old one: once, after it has waited that long. */
export function shouldTellStale(waitingSince: number | undefined, told: boolean, now: number): boolean {
  return !told && waitingSince !== undefined && now - waitingSince > STALE_BUILD_NOTICE_MS;
}
