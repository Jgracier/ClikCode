/** A command's work, stopped by what stops a process.
 *
 * Ctrl+C, SIGTERM (`timeout`, a supervisor) and SIGHUP (a closed terminal)
 * all mean "stop". Handing the turn an AbortSignal is how every transport --
 * a vendor CLI, an ACP agent, the Gateway loop -- learns it is cancelled
 * rather than failed; without one a killed vendor process read as a failure,
 * failover started the next account, and the command outlived the signal
 * sent to end it. The exit status is the conventional 128 + signal. */
const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export async function untilStopped<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const handlers = (Object.keys(STOP_SIGNALS) as (keyof typeof STOP_SIGNALS)[])
    .filter((name) => process.platform !== 'win32' || name !== 'SIGHUP')
    .map((name) => [name, () => { process.exitCode = STOP_SIGNALS[name]; controller.abort(); }] as const);
  for (const [name, handler] of handlers) process.once(name, handler);
  try {
    return await work(controller.signal);
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}
