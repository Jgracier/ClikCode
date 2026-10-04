/** /search for the user: the ranked conversations, and a walk through every
 * mention of the query -- Up/Down between mentions, Tab to the next
 * conversation. Pure state; the terminal draws it (tui/prompter.ts
 * showMention) and the editor opens the first mention. */

import { sessionDoc } from './corpus.js';
import type { ConversationHit, Mention, ParsedQuery, SearchResult } from './engine.js';
import { ago, runsOn, shortId } from './format.js';
import { maskSecrets } from './secrets.js';

export interface MentionStop {
  hit: ConversationHit;
  /** Rank of the conversation, from 0. */
  chat: number;
  /** Undefined for a conversation found by its title alone. */
  mention: Mention | undefined;
  /** Of the conversation's mentions, from 0. */
  index: number;
}

export const BROWSE_HINT = '↑↓ next/previous · tab next chat · esc done';

export class MentionBrowser {
  private chat = 0;
  private index = 0;

  constructor(private readonly hits: readonly ConversationHit[]) {
    if (!hits.length) throw new Error('nothing to browse');
  }

  current(): MentionStop {
    const hit = this.hits[this.chat]!;
    return { hit, chat: this.chat, mention: hit.mentions[this.index], index: this.index };
  }

  /** False at the last mention: it stays where it is. */
  next(): boolean {
    if (this.index + 1 >= this.hits[this.chat]!.mentions.length) return false;
    this.index += 1;
    return true;
  }

  previous(): boolean {
    if (this.index === 0) return false;
    this.index -= 1;
    return true;
  }

  /** The next-ranked conversation, from its first mention; after the last,
   * the first again. False when there is only one. */
  nextChat(): boolean {
    if (this.hits.length < 2) return false;
    this.chat = (this.chat + 1) % this.hits.length;
    this.index = 0;
    return true;
  }

  status(): string {
    const stop = this.current();
    const chats = this.hits.length > 1 ? ` · chat ${stop.chat + 1} of ${this.hits.length}` : '';
    const where = stop.mention ? `mention ${stop.index + 1} of ${stop.hit.mentions.length}` : 'title match, no mentions in it';
    return `${where}${chats} · ${BROWSE_HINT}`;
  }
}

/** Which occurrence of the query's first word, from the start of the
 * message, the mention is: how the screen finds its row. */
export async function mentionOccurrence(mention: Mention, query: ParsedQuery): Promise<number> {
  const message = (await sessionDoc(mention.sessionId))?.messages[mention.messageIndex];
  const word = query.words[0];
  if (!message || !word) return 0;
  let count = 0;
  for (let at = message.lower.indexOf(word); at >= 0 && at < mention.offset; at = message.lower.indexOf(word, at + word.length)) count += 1;
  return count;
}

/** The results as a list, for a screen that cannot browse them. */
export function searchResultsText(result: SearchResult, now = Date.now(), limit = 10): string {
  if (!result.hits.length) return `No conversation mentions "${maskSecrets(result.query.text)}".`;
  const lines = [`"${maskSecrets(result.query.text)}" — ${result.hits.length} conversation${result.hits.length === 1 ? '' : 's'}`];
  for (const hit of result.hits.slice(0, limit)) {
    lines.push(`  ${hit.mentions.length.toString().padStart(3)}  ${maskSecrets(hit.title)}  ${runsOn(hit)} · ${ago(hit.updatedAtMs, now)}${hit.titleMatch ? ' · title' : ''} · ${shortId(hit.sessionId)}`);
  }
  if (result.hits.length > limit) lines.push(`  … ${result.hits.length - limit} more`);
  return lines.join('\n');
}
