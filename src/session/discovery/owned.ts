/** Which vendor threads are ClikCode's own, so a vendor's history never lists
 * them as chats "not yet in ClikCode".
 *
 * ClikCode makes vendor threads all the time: every provider a conversation
 * runs on gets one, a written thread (turn/thread-start.ts) or one carried a
 * transfer prompt. A conversation that moves on lets go of the thread, and
 * the vendor's own list then showed it as a chat nobody had opened in
 * ClikCode -- dozens of "Untitled chat" rows that were all the same
 * conversations again. A thread is ClikCode's when a conversation uses it
 * now or has used it (`ownedThreads`, kept when it lets go), or -- for those
 * from before anything was kept -- when it opens with ClikCode's own words
 * (isClikCodeOpening): read with the vendor's listing where that reads the
 * thread's head (`byClikCode`), from the title it made of it, or from the
 * vendor's store (NativeSessionStore.openings). */

import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { isClikCodeOpening } from '../../turn/failover-prompt.js';
import type { HarnessState } from '../model.js';
import type { DiscoveredNativeSession } from './discovered-session.js';
import { NATIVE_SESSION_STORES, type NativeSessionEnvironment } from './registry.js';

export interface FoundNativeSession {
  harness: AiLocalHarnessDefinition;
  item: DiscoveredNativeSession;
  accountId?: string;
}

/** The threads in `found` that are the user's own chats to adopt.
 * `environmentFor` places an account's vendor store (its profile). */
export async function adoptableNativeSessions<T extends FoundNativeSession>(
  state: Pick<HarnessState, 'sessions'>, found: readonly T[],
  environmentFor: (accountId: string | undefined) => NativeSessionEnvironment = () => ({}),
): Promise<T[]> {
  const owned = new Set(state.sessions.flatMap((session) => session.ownedThreads ?? []));
  const open = found.filter(({ harness, item, accountId }) => !item.byClikCode
    && !(item.title && isClikCodeOpening(item.title))
    && !owned.has(`${harness.command}:${item.nativeId}`)
    // Open in a conversation now: on this account, where it says.
    && !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
  // The rest by their first message, one read of each vendor store.
  const stores = new Map<string, { root: string; items: T[] }>();
  for (const entry of open) {
    const store = NATIVE_SESSION_STORES[entry.harness.command];
    const root = store?.openings ? store.root(environmentFor(entry.accountId)) : undefined;
    if (!root) continue;
    const key = `${entry.harness.command}\u0000${root}`;
    stores.set(key, { root, items: [...stores.get(key)?.items ?? [], entry] });
  }
  const ours = new Set<T>();
  await Promise.all([...stores.values()].map(async ({ root, items }) => {
    const openings = await NATIVE_SESSION_STORES[items[0]!.harness.command]!.openings!(root, items.map(({ item }) => item.nativeId));
    for (const entry of items) {
      const opening = openings.get(entry.item.nativeId);
      if (opening && isClikCodeOpening(opening)) ours.add(entry);
    }
  }));
  return open.filter((entry) => !ours.has(entry));
}
