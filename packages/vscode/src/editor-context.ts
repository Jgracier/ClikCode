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

/** VS Code's own errors and warnings, under the selection or file they are in. */
export function problemsBlock(path: string, problems: readonly string[]): string {
  return `VS Code reports ${problems.length === 1 ? 'this problem' : 'these problems'} in \`${path}\`:\n${problems.map((problem) => `- ${problem}`).join('\n')}`;
}

const OPEN_FILE = /^Open in the editor: `([^`\n]+)`$/;
const SELECTION = /^`([^`\n]+)` lines? (\d+(?:-\d+)?):\n(`{3,})[\w+-]*\n[\s\S]*\n\3$/;
const PROBLEMS = /^VS Code reports (?:this problem|these problems) in `([^`\n]+)`:\n((?:- [^\n]*(?:\n|$))+)$/;

/** A sent message as typed, and the editor context the composer added after
 * it (problemsBlock; older messages also carried the open file): the transcript keeps the whole message,
 * and the bubble shows the context as a chip rather than as text the user
 * did not write. */
export function splitEditorContext(content: string): { text: string; file?: string; problems: number; selections: string[] } {
  let rest = content;
  let file: string | undefined;
  let problems = 0;
  const selections: string[] = [];
  // From the end: each block the composer appended, back to what was typed.
  for (;;) {
    const cut = lastBlock(rest);
    if (!cut) break;
    const open = OPEN_FILE.exec(cut.block);
    const reported = PROBLEMS.exec(cut.block);
    const selected = SELECTION.exec(cut.block);
    if (open) file ??= open[1];
    else if (reported) { file ??= reported[1]; problems += reported[2]!.trim().split('\n').length; }
    else if (selected) selections.unshift(`${selected[1]!.split(/[\\/]/).pop()}:${selected[2]}`);
    else break;
    rest = cut.before;
  }
  return { text: rest, ...(file ? { file } : {}), problems, selections };
}

/** The last paragraph-separated block, a fenced one whole (its code may hold
 * blank lines of its own). */
function lastBlock(text: string): { before: string; block: string } | undefined {
  const fence = /\n\n(`[^`\n]+` lines? \d+(?:-\d+)?:\n(`{3,})[\w+-]*\n[\s\S]*\n\2)$/.exec(text);
  if (fence && fence.index > 0) return { before: text.slice(0, fence.index), block: fence[1]! };
  const at = text.lastIndexOf('\n\n');
  return at > 0 ? { before: text.slice(0, at), block: text.slice(at + 2) } : undefined;
}

export function questionWithSelection(question: string, context: SelectionContext): string {
  return `${question.trim()}\n\n${selectionBlock(context)}`;
}
