/** Small pieces the bridge's parts share. */

/** A turn's own failure. The worker has already reported it (its turn-error
 * reaches the editor as a worker event), so the bridge does not say it twice. */
export class TurnFailed extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
