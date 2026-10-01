/** Long pastes held out of the composer as a placeholder.
 *
 * A pasted log or file is hundreds of lines the composer would grow to show,
 * pushing the conversation off the screen, when what the user needs to see is
 * that it is there. So the draft holds `[Pasted text #1 +40 lines]`
 * (turn-flow.ts's pastePlaceholder) and the text itself is kept here, put
 * back in its place when the message is sent -- Claude Code's way.
 *
 * The placeholder is one thing to the editor: Backspace at its end or Delete
 * at its start removes it whole, and with it the paste. Any other edit that
 * breaks it (a word deleted across it) drops the paste too, rather than send
 * a half-placeholder's worth of text nobody can see. Ctrl+O puts every held
 * paste back into the draft as text, to read or edit. */

import { pastePlaceholder } from '../../harness/protocol/turn-flow.js';

export type HeldPaste = { placeholder: string; text: string };

export type DraftWithPastes = { value: string; cursor: number; held: readonly HeldPaste[] };

/** A paste arriving at the cursor: held as a placeholder when it is long,
 * inserted as it is otherwise. `index` numbers it (`#index`). */
export function insertPaste(draft: DraftWithPastes, pasted: string, index: number): DraftWithPastes {
  const placeholder = pastePlaceholder(pasted, index);
  const shown = placeholder ?? pasted;
  return {
    value: draft.value.slice(0, draft.cursor) + shown + draft.value.slice(draft.cursor),
    cursor: draft.cursor + shown.length,
    held: placeholder ? [...draft.held, { placeholder, text: pasted }] : draft.held,
  };
}

/** Backspace at a placeholder's end, or Delete at its start: the whole
 * placeholder and its paste go. Undefined when the key is not at one. */
export function removePlaceholderAt(draft: DraftWithPastes, direction: 'back' | 'forward'): DraftWithPastes | undefined {
  for (const paste of draft.held) {
    const start = direction === 'back' ? draft.cursor - paste.placeholder.length : draft.cursor;
    if (start < 0 || draft.value.slice(start, start + paste.placeholder.length) !== paste.placeholder) continue;
    return {
      value: draft.value.slice(0, start) + draft.value.slice(start + paste.placeholder.length),
      cursor: start,
      held: draft.held.filter((other) => other !== paste),
    };
  }
  return undefined;
}

/** The pastes whose placeholder is still whole in the draft. */
export function keptPastes(value: string, held: readonly HeldPaste[]): HeldPaste[] {
  return held.filter((paste) => value.includes(paste.placeholder));
}

/** The draft with every held paste back in its placeholder's place: what is
 * sent, and what Ctrl+O shows. */
export function expandPastes(value: string, held: readonly HeldPaste[]): string {
  let expanded = value;
  for (const paste of held) {
    const at = expanded.indexOf(paste.placeholder);
    if (at >= 0) expanded = expanded.slice(0, at) + paste.text + expanded.slice(at + paste.placeholder.length);
  }
  return expanded;
}
