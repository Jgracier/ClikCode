/** What a vendor says with no prompt open and no tool running, kept in the
 * conversation exactly as it said it (harness/transport/background-turn.ts
 * OutOfTurnRelay). Nothing here runs, so nothing is shown as working.
 *
 * Chunks of one message arrive one at a time: each joins the record the
 * previous one made, as long as nothing else was added to the conversation
 * since. */
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { OutOfTurnRelay } from '../harness/transport/background-turn.js';

const last = new Map<string, { kind: 'message' | 'thought'; content: string }>();
const writing = new Map<string, Promise<unknown>>();

/** A relay that appends into `sessionId`'s conversation; its promise settles once the record is written. */
export function outOfTurnRecorder(sessionId: string): (said: Parameters<OutOfTurnRelay>[0]) => Promise<unknown> {
  return (said) => {
    const previous = writing.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const state = await readState({ transcripts: [sessionId] });
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const messages = [...session.messages ?? []];
      const tail = messages.at(-1);
      const known = last.get(sessionId);
      const continues = tail?.role === 'assistant' && known?.kind === said.kind && tail.content === known.content;
      const content = said.mode === 'replace' ? said.text : `${continues ? tail!.content : ''}${said.text}`;
      if (continues) messages[messages.length - 1] = { ...tail!, content };
      else messages.push({ role: 'assistant', content });
      session.messages = messages;
      session.updatedAt = new Date().toISOString();
      last.set(sessionId, { kind: said.kind, content });
      await writeState(state);
    }).catch(() => undefined);
    writing.set(sessionId, next);
    return next;
  };
}
