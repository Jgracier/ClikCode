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
import { conversationSummary, validSummary, type SummarySources } from '../session/conversation-summary.js';
import { fitRecord, nativeThreadBudget } from './thread-start.js';

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
  if (turn.interrupted) lines.push('[This turn was interrupted before it finished.]');
  return [
    { type: 'text', role: 'user', text: request || '(no request)' },
    { type: 'text', role: 'assistant', text: lines.join('\n\n') || '(no reply)' },
  ];
}

/** Writes the turns the agent's memory lacks into it, and says how many of
 * the conversation's turns it now holds. `receiving` is the provider key the
 * agent's own turns carry (`gateway:gateway`, `clikcode-local:…`). */
export async function seedAgentConversation(input: {
  session: HarnessSession; stateDir: string; contextWindow?: number; displayName?: (harness: string) => string | undefined;
  /** Where summaries other harnesses made of this conversation are read. */
  summaries?: SummarySources;
}): Promise<{ total: number; seeded: number; summarized?: number; summaryFrom?: string }> {
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
  if (through >= total) return { total, seeded: 0 };
  const receiving = `${session.route}:${session.provider ?? ''}`;
  // A summary another harness (or this agent, earlier) made of turns this
  // memory does not hold goes in as the agent's own compaction: what the
  // agent would have after compacting them itself, not a retelling of them.
  const summary = input.summaries
    ? validSummary(await conversationSummary(session, record, input.summaries).catch(() => undefined), record)
    : undefined;
  if (summary && summary.through > through) {
    const kept = { ...record, turns: record.turns.slice(summary.through) };
    const room = nativeThreadBudget(input.contextWindow) - Buffer.byteLength(summary.text, 'utf8');
    const fitted = fitRecord(markProviderBoundaries(kept, receiving, input.displayName), room);
    await store.appendCompaction(summary.text, fitted.record.turns.flatMap(agentItemsFromTurn));
    return { total, seeded: total - through, summarized: summary.through, summaryFrom: summary.source };
  }
  const missing = { ...record, turns: record.turns.slice(through) };
  const fitted = fitRecord(markProviderBoundaries(missing, receiving, input.displayName), nativeThreadBudget(input.contextWindow));
  await store.append(...fitted.record.turns.flatMap(agentItemsFromTurn));
  return { total, seeded: missing.turns.length };
}
