/** The one wait-for-a-while. */

/** Resolves after `ms`. With `signal`, rejects as soon as it aborts (at once
 * if it already has) with `aborted()`, or the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal, aborted?: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(aborted ? aborted() : signal!.reason);
    if (signal?.aborted) { fail(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = (): void => { clearTimeout(timer); fail(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
