/** A model's reply must never end on a recap line like
 * `[Did: $ npm test · Edit src/a.ts · and 5 more]`.
 *
 * Older turns of a long chat once carried that line as the end of the
 * assistant's own words, so models copied it and wrote one under their
 * answers, where it showed as plain text beside the (hidden) tool rows. Older
 * turns now carry what they did on the user side (turn/thread-start.ts), and
 * this is the guard for what a model still writes: one rule for the terminal,
 * the VS Code chat and what is saved. It is applied to MODEL output only; a
 * user who types such a line in their own message keeps it. */

/** A recap line, or one that ends a line of words. */
const RECAP_AT_END = /[ \t]*\[Did: [^\n]*\][ \t]*$/;

export function withoutRecapLine(text: string): string {
  if (!text.includes('[Did: ')) return text;
  let kept = text;
  for (;;) {
    const body = kept.replace(/\s+$/, '');
    const lineStart = body.lastIndexOf('\n') + 1;
    const line = body.slice(lineStart);
    const hit = RECAP_AT_END.exec(line);
    if (!hit) return kept === text ? text : kept.replace(/\s+$/, '');
    kept = body.slice(0, lineStart + hit.index);
    if (!kept.trim()) return '';
  }
}
