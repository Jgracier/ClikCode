/** The conversation, taken up by ClikCode's own agent.
 *
 * A vendor harness keeps its own thread, and ClikCode writes the conversation
 * into it when a provider takes the conversation over (thread-start.ts). The
 * agent that serves the Gateway and ClikCode Local keeps its memory in
 * `sessions/<id>/harness.jsonl`, and remembers only what it ran itself. A
 * conversation moved onto the Gateway from Claude Code, Codex or any other
 * harness arrived with an empty memory: the first turn answered a prompt that
 * referred to work it had never seen, and went looking for it.
 *
 * Here the turns the agent has not seen are written into that memory as the
 * turns they were -- the request, then the answer with its calls as lines --
 * bounded to what the model's window can carry, with the same note at each
 * change of provider that a written vendor thread gets. */
import { ConversationStore } from '../agent/conversation.js';
import type { ConversationItem } from '../agent/model-client.js';
import { canonicalRecord, markProviderBoundaries, withProviderNote, type CanonicalTurn } from '../session/canonical.js';
import type { HarnessSession } from '../session/model.js';
import { writeFullRecord } from '../session/full-record.js';
import { fitRecord, nativeThreadBudget } from './thread-start.js';
import { BYTES_PER_TOKEN } from './transfer.js';

/** Bytes of history the agent is seeded with: half the target model's window, as for any
 * written thread (thread-start.ts nativeThreadBudget), so the first request leaves the other
 * half for the system prompt, tools, the answer and the steps that follow. The model's window
 * is the only bound: there is no fixed ceiling in tokens, so a 1M-window model is handed what a
 * 1M window can carry. (A fixed 120k cap used to stop it at a fifth of that; what it saved was
 * the first step's price on a long conversation, which is the price of that conversation.) The
 * agent's context view (agent/context-view.ts) still fits every request to the model's window. */
export function agentSeedBudget(contextWindow?: number, readableTokens?: number): number {
  const byWindow = nativeThreadBudget(contextWindow);
  // A local model is also bounded by what it can read in about two minutes (local-models/read-budget.ts): there the window is
  // not the limit. What does not fit stays in the full record, which the agent can search and read.
  return readableTokens && readableTokens > 0 ? Math.min(byWindow, readableTokens * BYTES_PER_TOKEN) : byWindow;
}

/** One turn as the two messages the agent's memory holds. */
export function agentItemsFromTurn(turn: CanonicalTurn): ConversationItem[] {
  const request = [withProviderNote(turn, turn.user), turn.attachments.length ? `[Attached files: ${turn.attachments.join(', ')}]` : '']
    .filter((part) => part.trim()).join('\n\n');
  const lines: string[] = [];
  let calls: string[] = [];
  const flush = (): void => {
    if (calls.length) lines.push(`[Tool calls: ${calls.join('; ')}]`);
    calls = [];
  };
  for (const part of turn.parts) {
    if (part.type === 'text') {
      if (!part.text.trim()) continue;
      flush();
      lines.push(part.text.trim());
    } else {
      const status = part.call.status === 'failed' ? ' (failed)' : part.call.status === 'unfinished' ? ' (not finished)' : '';
      calls.push(`${part.call.label}${status}`);
    }
  }
  flush();
  if (turn.interrupted) lines.push(INTERRUPTED_NOTE);
  return [
    { type: 'text', role: 'user', text: request || '(no request)' },
    { type: 'text', role: 'assistant', text: lines.join('\n\n') || '(no reply)' },
  ];
}

const INTERRUPTED_NOTE = '[This turn was interrupted before it finished.]';

/** A turn the agent's memory already holds -- its request, and the steps that finished -- that was cut off
 * (the worker was stopped, the machine went down). What streamed since the last step reached the transcript
 * but never the memory; the model is told what was said and that the turn did not finish, once. */
async function noteInterruptedTail(store: ConversationStore, last: CanonicalTurn | undefined): Promise<void> {
  if (!last) return;
  const tail = (await store.load()).at(-1);
  // A turn that finished ends on the model's answer; anything else is a turn cut off.
  if (!tail || tail.type === 'summary' || (tail.type === 'text' && tail.role === 'assistant')) return;
  // Memory ends on the request: nothing of the answer is in it. Otherwise the steps are, and only the cut-off is news.
  if (tail.type === 'text' && tail.role === 'user') {
    const said = agentItemsFromTurn(last)[1]!;
    await store.append(said.type === 'text' && !said.text.includes(INTERRUPTED_NOTE) ? { ...said, text: `${said.text}\n\n${INTERRUPTED_NOTE}` } : said);
  }
  else await store.append({ type: 'text', role: 'assistant', text: INTERRUPTED_NOTE });
}

/** Writes the turns the agent's memory lacks into it, and says how many of
 * the conversation's turns it now holds. `receiving` is the provider key the
 * agent's own turns carry (`gateway:gateway`, `clikcode-local:…`). */
export async function seedAgentConversation(input: {
  session: HarnessSession; stateDir: string; contextWindow?: number; readableTokens?: number; displayName?: (harness: string) => string | undefined;
}): Promise<{ total: number; seeded: number }> {
  const { session } = input;
  // The turn about to run is not a turn yet: only what came before it.
  const record = canonicalRecord({ ...session, pendingTurn: undefined });
  const total = record.turns.length;
  const store = new ConversationStore(input.stateDir, session.id);
  let through = session.agentThreadTurns;
  // An empty memory holds nothing, whatever was counted. A conversation from
  // before the count was kept, with a memory, is taken as complete: nothing
  // says otherwise, and rewriting it would repeat turns it already has.
  if ((await store.size()) === 0) through = 0;
  else through ??= total;
  through = Math.min(through, total);
  if (through >= total) {
    await noteInterruptedTail(store, record.turns.at(-1));
    return { total, seeded: 0 };
  }
  const receiving = `${session.route}:${session.provider ?? ''}`;
  const missing = { ...record, turns: record.turns.slice(through) };
  // What does not fit is named with the file that holds the whole conversation:
  // no provider's summary stands in for turns (a handoff carries the conversation).
  const recordPath = await writeFullRecord(session, input.stateDir);
  const fitted = fitRecord(markProviderBoundaries(missing, receiving, input.displayName), agentSeedBudget(input.contextWindow, input.readableTokens), recordPath ? { recordPath } : {});
  await store.append(...fitted.record.turns.flatMap(agentItemsFromTurn));
  return { total, seeded: missing.turns.length };
}
