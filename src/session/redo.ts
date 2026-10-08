/** `/redo`: take the conversation back to just before one of the user's
 * prompts, so it can be sent again -- as it was, edited, or added to.
 *
 * Nothing is lost: the whole conversation is kept as an archived copy beside
 * this one first. Then, unless the files are to stay as they are, the edits of
 * that prompt's turn and every later one are put back, newest first, by
 * /undo's rules (a file changed since is left alone, and the walk stops
 * there). The conversation keeps the messages before the prompt and drops its
 * vendor thread, so the next turn starts a fresh one from ClikCode's record
 * (thread-start.ts) -- the vendor never sees what came after. */
import { randomUUID } from 'node:crypto';
import type { HarnessSession, HarnessState } from './model.js';
import { conversationIdFor } from './conversation-rows.js';
import { forgetNativeThread } from './native-thread.js';
import { isClikCodeAgent } from './route.js';
import { ConversationStore } from '../agent/conversation.js';
import { readTurnChanges, withTurnChangesLock, writeTurnChanges } from './turn-changes.js';
import { turnIsRunning, undoTurnsBack } from './undo-turn.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';
import { userMessageIndexes } from '../tui/slash/fork-at.js';

export interface Redo {
  /** The prompt, for the composer. */
  prompt: string;
  /** What was done, for the panel. */
  text: string;
}

export async function redoFrom(
  state: HarnessState, session: HarnessSession, n: number,
  options: { keepFiles: boolean; stateDir: string; who: string; turnIsRunning?: (sessionId: string) => Promise<boolean> },
): Promise<Redo> {
  if (await (options.turnIsRunning ?? turnIsRunning)(session.id)) throw new Error('A turn is running in this conversation: stop it first, then /redo.');
  const messages = sessionTranscriptMessages(session);
  const users = userMessageIndexes(messages);
  if (!Number.isInteger(n) || n < 1 || n > users.length) {
    throw new Error(users.length ? `No prompt ${n}: this conversation has prompts 1 to ${users.length}.` : 'This conversation has no prompts to redo yet.');
  }
  const at = users[n - 1]!;
  const prompt = messages[at]!.content;
  // That prompt's turn and every one after it.
  const turns = users.length - n + 1;
  const now = new Date().toISOString();
  state.sessions.push({
    ...session, id: randomUUID(), name: session.name ? `${session.name} (before redo)` : undefined,
    conversationId: conversationIdFor(session), parentSessionId: session.id, fork: true, messages,
    pendingTurn: undefined, nativeSessionId: undefined, nativeStartedAt: undefined,
    createdAt: now, updatedAt: now, status: 'archived', closedAt: now,
  });
  let files: string;
  if (options.keepFiles) {
    // The edits stay, so their records go: a later /undo must not reverse a
    // turn that is no longer in the conversation.
    await withTurnChangesLock(options.stateDir, session.id, async () => {
      const records = await readTurnChanges(options.stateDir, session.id);
      await writeTurnChanges(options.stateDir, session.id, records.slice(0, Math.max(0, records.length - turns)));
    });
    files = 'Files kept as they are.';
  } else {
    files = (await undoTurnsBack(session, turns, { stateDir: options.stateDir, who: options.who, turnIsRunning: async () => false })).text;
  }
  session.messages = messages.slice(0, at);
  session.pendingTurn = undefined;
  delete session.resumeAt;
  forgetNativeThread(session);
  // ClikCode's own agent remembers the turns that were cut away too: its
  // memory starts over, and the next turn writes the shortened conversation
  // into it (turn/agent-history.ts).
  if (isClikCodeAgent(session)) {
    await new ConversationStore(options.stateDir, session.id).archive();
    delete session.agentThreadTurns;
  }
  session.updatedAt = now;
  return {
    prompt,
    text: `Back to before prompt ${n}; it is in the message box to send again. The conversation as it was is archived beside this one.\n\n${files}`,
  };
}
