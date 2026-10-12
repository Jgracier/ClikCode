/** One swarm setting. Off unless this conversation turned it on. While it is
 * on, the host delegates a task when another account can do it for less than
 * doing it here, and keeps the small ones. */

export interface SwarmPolicy {
  /** Tokens a clerk may be briefed with, including the board slice. */
  maxBriefTokens: number;
  /** Tokens the shared board may hold. */
  maxBoardTokens: number;
  /** Tokens of one clerk's card that may re-enter the host. */
  maxCardTokens: number;
}

/** The caps for a conversation with swarm on. */
export const SWARM_POLICY: SwarmPolicy = {
  maxBriefTokens: 20000,
  maxBoardTokens: 2000,
  maxCardTokens: 4000,
};

/** True when this conversation delegates. */
export function swarmIsOn(session: { swarm?: boolean | undefined }): boolean {
  return session.swarm === true;
}
