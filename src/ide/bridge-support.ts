/** Small pieces the bridge's parts share. */

/** A turn's own failure. The worker has already reported it (its turn-error
 * reaches the editor as a worker event), so the bridge does not say it twice. */
export class TurnFailed extends Error {}

/** The worker refused a prompt because it is being replaced (a newer build, a move): nothing was started, so the same prompt goes to the one that
 * replaces it. Not a turn's own failure, so it is not reported. */
export class WorkerRetiring extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
