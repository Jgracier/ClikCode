/** One swarm setting. Off unless this conversation turned it on. While it is
 * on, the host delegates a task when another account can do it for less than
 * doing it here, and keeps the small ones. */

export interface SwarmPolicy {
  /** Optional cap on concurrent workers for testing or constrained environments. Defaults to unlimited. */
  maxWorkers?: number;
  /** Optional cap on parallel calls for testing or constrained environments. Defaults to unlimited. */
  maxParallel?: number;
  /** Tokens a clerk may be briefed with, including the board slice. */
  maxBriefTokens: number;
  /** Tokens the shared board may hold. */
  maxBoardTokens: number;
  /** Tokens of one clerk's card that may re-enter the host. */
  maxCardTokens: number;
}

/** The caps for a conversation with swarm on. No artificial limit on parallel workers. */
export const SWARM_POLICY: SwarmPolicy = {
  maxBriefTokens: 20000,
  maxBoardTokens: 2000,
  maxCardTokens: 4000,
};

/** True when this conversation delegates. A saved `lean` or `frugal` list
 * from the earlier presets still counts as on. */
export function swarmIsOn(session: { swarm?: boolean | readonly string[] | undefined }): boolean {
  if (session.swarm === true) return true;
  return Array.isArray(session.swarm) && session.swarm.length > 0;
}
