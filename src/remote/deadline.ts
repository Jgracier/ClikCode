/** Bound a protocol acknowledgement, never retry or cancel the underlying work. */
export async function remoteDeadline<T>(work: Promise<T>, message: string, ms = 60_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
