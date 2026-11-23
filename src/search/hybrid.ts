/** When conversations are embedded, and the query vector the conversation
 * tools search with (tools.ts). The embedder (embedder.ts) is optional
 * throughout: none ready means lexical search alone, said nowhere.
 *
 * - After each turn, its conversation catches up (indexAfterTurn).
 * - A hindsight query first catches up the conversation it reads, for at
 *   most CATCH_UP_MS.
 * - Any conversation search then backfills the rest in the background,
 *   newest first, at most BACKFILL_MS per pass and one pass at a time in a
 *   process; what is left waits for the next search. */

import { conversationGroups, findConversation, type ConversationGroup } from './conversations.js';
import { embedderWithin, type Embedder } from './embedder.js';
import { indexConversation } from './vectors.js';

/** How long a tool call waits for the embedder before going lexical. */
const READY_WAIT_MS = 1500;
const CATCH_UP_MS = 4000;
const BACKFILL_MS = 30_000;

export interface QueryVector { vector: Float32Array; embedderId: string }

/** The query as a vector, when an embedder is ready soon enough. */
export async function queryVector(text: string, waitMs = READY_WAIT_MS): Promise<QueryVector | undefined> {
  const embedder = await embedderWithin(waitMs);
  if (!embedder) return undefined;
  try {
    const [vector] = await embedder.embed([text], 'query');
    return vector ? { vector, embedderId: embedder.id } : undefined;
  } catch { return undefined; }
}

/** Embed what `group` lacks, for at most `ms`. */
export async function catchUp(group: ConversationGroup, ms = CATCH_UP_MS): Promise<void> {
  const embedder = await embedderWithin(0);
  if (embedder) await indexConversation(group, embedder, { deadline: Date.now() + ms }).catch(() => undefined);
}

let backfilling: Promise<void> | undefined;

/** One bounded pass over every conversation, newest first, in the background. */
export function backfill(budgetMs = BACKFILL_MS): Promise<void> {
  backfilling ??= (async () => {
    const embedder = await embedderWithin(0);
    if (!embedder) return;
    const deadline = Date.now() + budgetMs;
    const groups = (await conversationGroups()).sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    for (const group of groups) {
      if (Date.now() > deadline) break;
      const result = await indexConversation(group, embedder, { deadline }).catch(() => undefined);
      if (result?.skipped === 'failed') break;
    }
  })().catch(() => undefined).finally(() => { backfilling = undefined; });
  return backfilling;
}

/** After a turn ends: embed the conversation's new messages, starting the
 * embedder (and fetching it, the first time) if it is not running. Never
 * throws, never waits on the caller's behalf. */
export function indexAfterTurn(sessionId: string, embedder?: Embedder): Promise<void> {
  return (async () => {
    const ready = embedder ?? await embedderWithin(5 * 60_000);
    if (!ready) return;
    const found = findConversation(await conversationGroups(), sessionId);
    if (found) await indexConversation(found.group, ready, { deadline: Date.now() + 60_000 });
  })().catch(() => undefined);
}
