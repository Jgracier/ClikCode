/** /search in the panel, walked as the terminal walks it
 * (tui/slash/search-browse.ts): the conversation is open at a mention, its
 * words marked and the mention itself brought into view; ↓/↑ the next or
 * previous mention, Tab the next conversation, Esc done. ClikCode decides
 * where each step lands; this only shows it and sends the keys. */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { IdeSearchFocus } from '../protocol';
import type { WebviewSearchKey } from '../webview-protocol';
import { post } from './bus';
import { focusHere, Icon, IconButton } from './ui';

const KEYS: Record<string, WebviewSearchKey> = { ArrowDown: 'next', ArrowUp: 'previous', Tab: 'chat', Escape: 'done' };

const send = (key: WebviewSearchKey): void => post({ type: 'search-key', key });

export function SearchBar({ focus }: { focus: IdeSearchFocus }): JSX.Element {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => { focusHere(bar.current); }, []);
  return (
    <div class="search-bar" ref={bar} tabIndex={0} role="toolbar" aria-label="Search conversations"
      onKeyDown={(event) => {
        const key = KEYS[event.key];
        if (!key) return;
        event.preventDefault();
        send(key);
      }}>
      <Icon name="search" />
      <span class="search-status">{focus.status}</span>
      <IconButton icon="arrow-up" label="Previous mention (↑)" onClick={() => send('previous')} />
      <IconButton icon="arrow-down" label="Next mention (↓)" onClick={() => send('next')} />
      <IconButton icon="arrow-right" label="Next conversation (Tab)" onClick={() => send('chat')} />
      <IconButton icon="close" label="Done (Esc)" onClick={() => send('done')} />
    </div>
  );
}

const MARKS = 'clikcode-search';
const CURRENT = 'clikcode-search-current';

/** Marks the words in the focused message and scrolls the mention into
 * view. False while the message is not drawn yet (the conversation is still
 * arriving): called again on the next draw. */
export function markMention(focus: IdeSearchFocus | undefined): boolean {
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
  registry?.delete(MARKS);
  registry?.delete(CURRENT);
  if (!focus) return true;
  const message = document.querySelector<HTMLElement>(`.transcript [data-message="${focus.messageIndex}"]`);
  if (!message) return false;
  const ranges: Range[] = [];
  let mention: Range | undefined;
  let seen = 0;
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').toLowerCase();
    for (const word of focus.words) {
      for (let at = word ? text.indexOf(word) : -1; at >= 0; at = text.indexOf(word, at + word.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
        if (word === focus.words[0] && seen++ === focus.occurrence) mention = range;
      }
    }
  }
  if (registry && ranges.length) {
    registry.set(MARKS, new Highlight(...ranges));
    if (mention) registry.set(CURRENT, new Highlight(mention));
  }
  const target = mention?.startContainer.parentElement ?? (message.firstElementChild as HTMLElement | null) ?? message;
  target.scrollIntoView({ block: 'center' });
  return true;
}
