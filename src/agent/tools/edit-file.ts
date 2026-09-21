import { eventDiff, renderDiffPreview } from '../line-diff.js';
import { defineTool, type ToolContext } from '../tool-contract.js';
import { displayPath, resolveForWrite, ToolInputError } from './fs-helpers.js';
import { readExisting, rememberWritten, writeTextAtomic } from './write-file.js';

export interface EditOperation { old_string: string; new_string: string; replace_all?: boolean }
interface EditFileArgs extends EditOperation { path: string }

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
}

/** Apply one exact-match replacement. The file's dominant line ending is
 * preserved: the model almost always sends `\n`, so on a CRLF file both the
 * search and the replacement are converted before matching. */
function applyEdit(content: string, edit: EditOperation, label = 'old_string'): string {
  if (edit.old_string === edit.new_string) throw new ToolInputError(`${label} and new_string are identical; nothing to change.`);
  if (!edit.old_string) throw new ToolInputError(`${label} is empty. To create a file use write_file.`);
  const crlf = (content.match(/\r\n/g)?.length ?? 0) > (content.match(/(?<!\r)\n/g)?.length ?? 0);
  const normalize = (text: string): string => crlf ? text.replace(/\r?\n/g, '\r\n') : text;
  let needle = edit.old_string;
  let replacement = edit.new_string;
  if (!content.includes(needle) && content.includes(normalize(needle))) { needle = normalize(needle); replacement = normalize(replacement); }
  else if (crlf && needle.includes('\r\n')) replacement = normalize(replacement);
  const count = countOccurrences(content, needle);
  if (count === 0) throw new ToolInputError(`${label} was not found. It must match the file exactly, including whitespace and indentation. Re-read the file and copy the text verbatim.`);
  if (count > 1 && !edit.replace_all) throw new ToolInputError(`${label} matches ${count} places. Add surrounding lines to make it unique, or set replace_all to change every occurrence.`);
  return edit.replace_all ? content.split(needle).join(replacement) : content.replace(needle, () => replacement);
}

interface PreparedEdit { real: string; shown: string; before: string; after: string; mode: number }

/** Validate everything (guards + all edits) without touching the disk. */
export async function prepareEdits(filePath: string, edits: readonly EditOperation[], ctx: ToolContext, enforceReadGuard = true): Promise<PreparedEdit> {
  const resolved = resolveForWrite(filePath, ctx);
  const existing = await readExisting(resolved.real);
  if (!existing) throw new ToolInputError(`File not found: ${filePath}. Use write_file to create it.`);
  if (enforceReadGuard) {
    const stamp = ctx.session.readFiles.get(resolved.real);
    if (!stamp) throw new ToolInputError(`Read ${filePath} with read_file before editing it.`);
    if (Math.abs(stamp.mtimeMs - existing.mtimeMs) > 1) throw new ToolInputError(`${filePath} changed on disk since it was last read. Read it again before editing.`);
  }
  let after = existing.text;
  edits.forEach((edit, index) => { after = applyEdit(after, edit, edits.length > 1 ? `edits[${index}].old_string` : 'old_string'); });
  return { real: resolved.real, shown: displayPath(resolved.absolute, ctx), before: existing.text, after, mode: existing.mode };
}

export async function commitEdit(prepared: PreparedEdit, ctx: ToolContext): Promise<void> {
  await ctx.checkpoints.snapshot(ctx.sessionId, ctx.turnId, prepared.real);
  await writeTextAtomic(prepared.real, prepared.after, prepared.mode);
  await rememberWritten(prepared.real, ctx);
}

export const editFileTool = defineTool<EditFileArgs>({
  name: 'edit_file',
  class: 'write',
  description: 'Replace an exact string in a file. old_string must match the file verbatim (whitespace included, without the line-number prefix from read_file) and be unique unless replace_all is true. Read the file first. Keep old_string as small as uniqueness allows.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'],
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
  },
  label: (args) => `Edit ${args.path}`,
  paths: (args) => [args.path],
  async preview(args, ctx) {
    const prepared = await prepareEdits(args.path, [args], ctx, false);
    return renderDiffPreview(prepared.before, prepared.after);
  },
  async run(args, ctx) {
    const prepared = await prepareEdits(args.path, [args], ctx);
    await commitEdit(prepared, ctx);
    return { output: `Edited ${prepared.shown}.`, diff: eventDiff(prepared.before, prepared.after) };
  },
});

