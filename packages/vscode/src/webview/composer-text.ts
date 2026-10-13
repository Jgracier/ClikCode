/** What the message box does with text: commands, prompt history, the @ and / token at the caret, and the message that is sent. */
import { isClikCodeNotice } from '../../../../src/session/clikcode-notice';
import type { PaletteEntry } from '../../../../src/tui/command-palette';
import type { IdeSlashCommand } from '../protocol';
import type { Mention } from '../webview-protocol';
import { problemsBlock, selectionBlock, splitEditorContext } from '../editor-context';

/** A chip above the message box: lines referenced, an image, or a long
 * paste held as `[Pasted text #1 +40 lines]` (its `text` goes with the
 * message). */
export interface Attachment { key: string; kind: 'selection' | 'image' | 'pasted'; label: string; mention?: Mention; path?: string; preview?: string; text?: string }

export const sameRange = (left: Mention | undefined, right: Mention): boolean =>
  left?.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;

/** A bridge command row as the terminal palette's entry, so the same matcher
 * (command-palette.ts) ranks and completes it. */
export function paletteEntry(item: IdeSlashCommand): PaletteEntry {
  return {
    label: item.command, value: item.command, detail: item.description,
    ...(item.argHint ? { argHint: item.argHint } : {}), ...(item.group ? { group: item.group } : {}),
    ...(item.aliases?.length ? { aliases: item.aliases } : {}),
    ...(item.argValues?.length ? { argValues: () => item.argValues! } : {}),
  };
}

/** The prompts ↑ and ↓ step through: this conversation's own, oldest first,
 * repeats in a row once -- as the terminal recalls what was typed, though
 * read from the transcript so every tab and window on it has them. */
export function promptHistory(messages: ReadonlyArray<{ role: string; content: string }>): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    // A notice ClikCode sent in the user's place is not something they typed.
    const typed = message.role === 'user' && !isClikCodeNotice(message.content) ? splitEditorContext(message.content).text : '';
    if (!typed.trim()) continue;
    if (prompts[prompts.length - 1] !== typed) prompts.push(typed);
  }
  return prompts.slice(-200);
}

/** The @ or / token the caret is in, if any. A / command is the whole first
 * line up to the caret, its argument included, so `/model op` lists models. */
export function tokenAtCaret(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:-]*(?: [^\n]*)?)$/.exec(before);
  if (slash) return { kind: '/', query: slash[1]!, start: 0 };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: '@', query: at[1]!, start: caret - at[1]!.length - 1 };
  return undefined;
}

/** What is sent: the typed text, then each attachment in order -- a long
 * paste's own text, a referenced range of lines as a fenced block (with the
 * problems VS Code reports in it), an image's path (ClikCode attaches image
 * paths it finds in a message). */
export function composeMessage(text: string, attachments: ReadonlyArray<{ kind: 'selection' | 'image' | 'pasted'; mention?: Mention; path?: string; text?: string }>): string {
  const blocks = attachments.flatMap((attachment) => {
    if (attachment.kind === 'pasted') return attachment.text?.trim() ? [attachment.text.replace(/\r\n/g, '\n').replace(/\n+$/, '')] : [];
    if (attachment.kind === 'image' && attachment.path) return [attachment.path];
    const mention = attachment.mention;
    if (!mention) return [];
    const problems = mention.problems?.length ? [problemsBlock(mention.label, mention.problems)] : [];
    if (!mention.text) return [`@${mention.label}`];
    return [selectionBlock({ path: mention.label, languageId: mention.languageId ?? '', startLine: mention.startLine ?? 1, endLine: mention.endLine ?? 1, text: mention.text }), ...problems];
  });
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}
