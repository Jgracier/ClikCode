/** /search in the terminal: the conversation with the most mentions opens
 * at its first one, matches highlighted; Up/Down walk its mentions, Tab
 * moves to the next-ranked conversation, Esc stays where it is. */
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { searchConversations } from '../../search/engine.js';
import { MentionBrowser, mentionOccurrence } from '../../search/navigate.js';
import type { MentionFocus } from '../render/search-focus.js';
import type { InteractiveSlashOutcome } from './interactive-keys.js';

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
    const session = await load(stop.mention.sessionId);
    if (session) {
      shown = session.id;
      screen.showMention(session, {
        messageIndex: stop.mention.messageIndex,
        occurrence: await mentionOccurrence(stop.mention, result.query),
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
