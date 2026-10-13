/** How a resource note is written into, and cut out of, a turn's text. Pure on purpose: transcript
 * readers (and so the editor's bundle) need it, and must not be tied to the disk code that holds notes. */
const OPEN = '<clikcode_resource_note>';
const CLOSE = '</clikcode_resource_note>';
const LEADING_NOTES = /^(?:\s*<clikcode_resource_note>[\s\S]*?<\/clikcode_resource_note>)+\s*/;

export function wrapResourceNote(text: string): string { return `${OPEN}\n${text.trim()}\n${CLOSE}`; }
export function stripResourceNotes(content: string): string { return content.replace(LEADING_NOTES, ''); }
