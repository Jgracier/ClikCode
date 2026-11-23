/** How a resource note is written into, and cut out of, a turn's text. Pure on purpose: transcript
 * readers (and so the editor's bundle) need it, and must not be tied to the disk code that holds notes.
 *
 * A recall note (search/recall.ts) is the other note ClikCode adds to a request: earlier messages of the
 * conversation that match it, put AFTER the user's words so what the vendor has cached of the thread
 * stays as it was. Both come out wherever a request is read back as the user's. */
const OPEN = '<clikcode_resource_note>';
const CLOSE = '</clikcode_resource_note>';
const LEADING_NOTES = /^(?:\s*<clikcode_resource_note>[\s\S]*?<\/clikcode_resource_note>)+\s*/;
const RECALL_OPEN = '<clikcode_recall>';
const RECALL_CLOSE = '</clikcode_recall>';
const TRAILING_RECALL = /\s*<clikcode_recall>[\s\S]*?<\/clikcode_recall>\s*$/;

export function wrapResourceNote(text: string): string { return `${OPEN}\n${text.trim()}\n${CLOSE}`; }
export function wrapRecallNote(text: string): string { return `${RECALL_OPEN}\n${text.trim()}\n${RECALL_CLOSE}`; }
export function stripResourceNotes(content: string): string { return content.replace(LEADING_NOTES, '').replace(TRAILING_RECALL, ''); }
