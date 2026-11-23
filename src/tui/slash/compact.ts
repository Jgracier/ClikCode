/** `/compact` and `/compact <tokens>` (turn/compaction.ts): compact the conversation now, or
 * set the one threshold at which ClikCode compacts every conversation by itself. */

import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { isClikCodeAgent, AGENT_COMPACT_UNAVAILABLE } from '../../session/route.js';
import {
  COMPACT_REQUEST, MIN_COMPACT_AT_TOKENS, NOTHING_TO_COMPACT, compactFailedLine, noteCompactAt, parseCompactAt, tokenLabel,
} from '../../turn/compaction.js';
import { hasThreadToCompact } from '../../turn/compaction-run.js';

/** What `/compact [args]` did: a line to show, or nothing (a compaction turn was sent and says itself). */
export async function compactConversation(
  id: string, session: HarnessSession, args: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<string | undefined> {
  if (args.trim()) return setCompactThreshold(args);
  if (isClikCodeAgent(session)) throw new Error(compactFailedLine(AGENT_COMPACT_UNAVAILABLE));
  if (!hasThreadToCompact(session)) return NOTHING_TO_COMPACT;
  await send(id, COMPACT_REQUEST);
  return undefined;
}

/** `/compact <tokens>`: kept for every harness and every conversation (globalSettings.compactAt). */
async function setCompactThreshold(word: string): Promise<string> {
  const tokens = parseCompactAt(word);
  if (tokens === undefined) throw new Error('usage: /compact [tokens, such as 150k]');
  if (tokens < MIN_COMPACT_AT_TOKENS) throw new Error(`The threshold must be at least ${tokenLabel(MIN_COMPACT_AT_TOKENS)} tokens.`);
  const state = await readState({ transcripts: [] });
  state.globalSettings.compactAt = tokens;
  await writeState(state);
  noteCompactAt(state.globalSettings);
  return `Compacts at ${tokenLabel(tokens)} tokens.`;
}
