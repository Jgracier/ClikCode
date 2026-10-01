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

/** The file in front of the user, when nothing in it is selected. */
export function openFileLine(path: string): string {
  return `Open in the editor: \`${path}\``;
}

/** VS Code's own errors and warnings, under the selection or file they are in. */
export function problemsBlock(path: string, problems: readonly string[]): string {
  return `VS Code reports ${problems.length === 1 ? 'this problem' : 'these problems'} in \`${path}\`:\n${problems.map((problem) => `- ${problem}`).join('\n')}`;
}

const OPEN_FILE = /^Open in the editor: `([^`\n]+)`$/;
const PROBLEMS = /^VS Code reports (?:this problem|these problems) in `([^`\n]+)`:\n((?:- [^\n]*(?:\n|$))+)$/;

/** A sent message as typed, and the editor context the composer added after
 * it (openFileLine, problemsBlock): the transcript keeps the whole message,
 * and the bubble shows the context as a chip rather than as text the user
 * did not write. */
export function splitEditorContext(content: string): { text: string; file?: string; problems: number } {
  const parts = content.split('\n\n');
  let file: string | undefined;
  let problems = 0;
  while (parts.length > 1) {
    const last = parts[parts.length - 1]!;
    const open = OPEN_FILE.exec(last);
    const reported = PROBLEMS.exec(last);
    if (open) file ??= open[1];
    else if (reported) { file ??= reported[1]; problems += reported[2]!.trim().split('\n').length; }
    else break;
    parts.pop();
  }
  return { text: parts.join('\n\n'), ...(file ? { file } : {}), problems };
}

export function questionWithSelection(question: string, context: SelectionContext): string {
  return `${question.trim()}\n\n${selectionBlock(context)}`;
}
