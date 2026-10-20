/** Requests to the bridge: how long each kind may take, and what is said when
 * one cannot be delivered. */
import type { BridgeEndpoint } from '../bridge-client';
import type { IdeRequest } from '../protocol';

/** Deadlines (ms) for what the bridge is asked. */
export const TIMEOUT = {
  /** The bridge's `ready` after it was spawned. */
  start: 60_000,
  /** The composer footer's structured reads. */
  structured: 30_000,
  /** A panel's query (a provider's model list can go to the network). */
  query: 120_000,
  /** A choice can take a sign-in or an install: no short deadline. */
  choose: 30 * 60_000,
} as const;

/** Hands a request to the bridge; when it is gone the user is told (through
 * `warn`), not left waiting on something that will never be heard. */
export function deliver(bridge: BridgeEndpoint | undefined, request: IdeRequest, what: string, warn: (text: string) => void): boolean {
  if (bridge?.send(request)) return true;
  warn(`${what} was not delivered: ClikCode is not connected. Try again once it has reconnected.`);
  return false;
}
