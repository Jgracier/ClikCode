/** Editor context attached to a message: the selection, where it is from. */

export interface SelectionContext {
  /** Workspace-relative where possible. */
  path: string;
  languageId: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** The longest run of backticks inside the text, plus one, so a selection
 * that itself contains a fenced block cannot close the fence early. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(longest + 1);
}

export function selectionBlock(context: SelectionContext): string {
  const lines = context.startLine === context.endLine ? `line ${context.startLine}` : `lines ${context.startLine}-${context.endLine}`;
  const fence = fenceFor(context.text);
  const language = /^[\w+-]+$/.test(context.languageId) && context.languageId !== 'plaintext' ? context.languageId : '';
  return `\`${context.path}\` ${lines}:\n${fence}${language}\n${context.text.replace(/\s+$/, '')}\n${fence}`;
}

export function questionWithSelection(question: string, context: SelectionContext): string {
  return `${question.trim()}\n\n${selectionBlock(context)}`;
}
