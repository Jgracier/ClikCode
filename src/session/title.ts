/** What a conversation is called.
 *
 * The vendor's own title when it reports one (Claude Code records the name of
 * its thread in its transcript), otherwise the user's first message, cut to
 * length. Computed here and never by editing what is sent to the model.
 */

/** Long enough to say what a chat is about, short enough to sit on the rule
 * above the composer next to everything else that lives there. */
export const SESSION_TITLE_MAX = 20;

/** Collapsed, unquoted, and cut to the limit on a word boundary where there is
 * one, so a long name still reads as words. */
export function normalizeSessionTitle(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '').replace(/[.。]+$/, '').trim();
  if (!text) return undefined;
  if (text.length <= SESSION_TITLE_MAX) return text;
  const cut = text.slice(0, SESSION_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return (space >= SESSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The name a conversation gets from the user's first message. */
export function titleFromFirstMessage(message: string): string | undefined {
  return normalizeSessionTitle(message);
}

/** Older ClikCode appended a title request to a first prompt and asked the
 * model to open its reply with a marker. Transcripts written then still carry
 * them; they are taken off on the way out. */
const LEGACY_OPEN = '<clikcode-title>';
const LEGACY_CLOSE = '</clikcode-title>';

/** Whether a message ends with a title request an older ClikCode sent. */
export function carriesTitleRequest(text: string): boolean {
  return new RegExp(`\\n\\n${LEGACY_OPEN}[\\s\\S]*${LEGACY_CLOSE}\\s*$`).test(text);
}

/** A stored reply with a legacy title line removed wherever a step began with one. */
export function stripRepeatedTitles(text: string): string {
  return text.replace(new RegExp(`(^|\\n)[ \\t]*${LEGACY_OPEN}[\\s\\S]*?${LEGACY_CLOSE}[ \\t]*\\r?\\n?`, 'g'), '$1').replace(/^\n+/, '');
}
