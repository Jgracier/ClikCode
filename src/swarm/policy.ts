/** One swarm setting. Off unless this conversation turned it on. While it is
 * on, the host delegates a task when another account can do it for less than
 * doing it here, and keeps the small ones. */

export interface SwarmPolicy {
  maxWorkers: number;
  maxParallel: number;
  /** Tokens a clerk may be briefed with, including the board slice. */
  maxBriefTokens: number;
  /** Tokens the shared board may hold. */
  maxBoardTokens: number;
  /** Tokens of one clerk's card that may re-enter the host. */
  maxCardTokens: number;
}

/** The caps for a conversation with swarm on. */
export const SWARM_POLICY: SwarmPolicy = {
  maxWorkers: 2,
  maxParallel: 2,
  maxBriefTokens: 12000,
  maxBoardTokens: 400,
  maxCardTokens: 300,
};

/** True when this conversation delegates. A saved `lean` or `frugal` list
 * from the earlier presets still counts as on. */
export function swarmIsOn(session: { swarm?: boolean | readonly string[] | undefined }): boolean {
  if (session.swarm === true) return true;
  return Array.isArray(session.swarm) && session.swarm.length > 0;
}
