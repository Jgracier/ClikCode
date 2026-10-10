/** /search in the terminal: the conversation with the most mentions opens
 * at its first one, matches highlighted; Up/Down walk its mentions, Tab
 * moves to the next-ranked conversation, Esc stays where it is. */
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { searchConversations } from '../../search/engine.js';
import { MentionBrowser, mentionOccurrence } from '../../search/navigate.js';
import type { MentionFocus } from '../render/search-focus.js';
import type { InteractiveSlashOutcome } from './interactive-keys.js';
import { stateDirectory } from '../../session/store/paths.js';
import { readTurnChanges, turnMessageIndex } from '../../session/turn-changes.js';

/** What browsing needs of the screen (TerminalHarnessPrompter). */
export interface MentionScreen {
  showMention(session: HarnessSession, focus: MentionFocus): void;
  mentionKey(): Promise<'next' | 'previous' | 'chat' | 'done'>;
  endMention(): void;
}

export async function browseSearch(
  screen: MentionScreen, query: string, withBusy: <T>(label: string, work: () => Promise<T>) => Promise<T>,
): Promise<InteractiveSlashOutcome> {
  const result = await withBusy('searching conversations…', () => searchConversations(query));
  if (!result?.hits.length) return { notice: `No conversation mentions "${query}"` };
  const browser = new MentionBrowser(result.hits);
  const sessions = new Map<string, HarnessSession | undefined>();
  const load = async (id: string): Promise<HarnessSession | undefined> => {
    if (!sessions.has(id)) sessions.set(id, (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id));
    return sessions.get(id);
  };
  let shown: string | undefined;
  for (;;) {
    const stop = browser.current();
    // Found by its title alone: the conversation at its latest message.
    const session = await load(stop.mention?.sessionId ?? stop.hit.sessionId);
    if (session) {
      shown = session.id;
      screen.showMention(session, {
        messageIndex: stop.mention?.messageIndex ?? Math.max(0, (session.messages?.length ?? 1) - 1),
        occurrence: stop.mention ? await mentionOccurrence(stop.mention, result.query) : 0,
        words: result.query.words,
        status: browser.status(),
      });
    }
    const key = await screen.mentionKey();
    if (key === 'done') break;
    if (key === 'next') browser.next();
    else if (key === 'previous') browser.previous();
    else browser.nextChat();
  }
  screen.endMention();
  return shown ? { id: shown } : {};
}

/** /changes <path>, once a turn is chosen: its conversation opens at that
 * turn's prompt; Up/Down move to the next and previous turn of the list
 * (newest first), Esc stays where it is. */
export async function walkTurns(
  screen: MentionScreen, turns: readonly { sessionId: string; turnsAgo: number }[], start: number,
): Promise<InteractiveSlashOutcome> {
  let at = Math.max(0, Math.min(turns.length - 1, start));
  let shown: string | undefined;
  for (;;) {
    const turn = turns[at]!;
    const session = (await readState({ transcripts: [turn.sessionId] })).sessions.find((item) => item.id === turn.sessionId);
    if (session) {
      shown = session.id;
      const messages = session.messages ?? [];
      const records = await readTurnChanges(stateDirectory(), session.id);
      screen.showMention(session, {
        messageIndex: turnMessageIndex(messages, records, turn.turnsAgo) ?? Math.max(0, messages.length - 1),
        occurrence: 0, words: [], status: `turn ${at + 1} of ${turns.length} · ↑↓ next/previous · esc done`,
      });
    }
    const key = await screen.mentionKey();
    if (key === 'done') break;
    at = key === 'previous' ? Math.max(0, at - 1) : Math.min(turns.length - 1, at + 1);
  }
  screen.endMention();
  return shown ? { id: shown } : {};
}
