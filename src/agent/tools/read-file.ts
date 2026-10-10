import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_CAPS } from '../security.js';
import { defineTool } from '../tool-contract.js';
import { displayPath, IMAGE_EXTENSIONS, looksBinary, resolveForRead } from './fs-helpers.js';
import { isNotebookPath, parseNotebook, renderNotebook } from './notebook.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { IMAGE_MIME, MAX_IMAGE_SIDE, MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import type { ToolRunResult } from '../tool-contract.js';

interface ReadFileArgs { path: string; offset?: number; limit?: number }

const MAX_READ_BYTES = 20 * 1024 * 1024;

export const readFileTool = defineTool<ReadFileArgs>({
  name: 'read_file',
  class: 'read',
  description: 'Read a text file. Returns numbered lines (`N\\tline`). Reads up to 2000 lines from the start by default; use offset (1-based line) and limit for large files. A PNG, JPEG, GIF or WebP image is shown to you as the picture itself.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
    },
  },
  label: (args) => formatToolRow('read_file', args.path, 'read'),
  paths: (args) => [args.path],
  async run(args, ctx) {
    const resolved = resolveForRead(args.path, ctx);
    let stat;
    try { stat = await fs.stat(resolved.real); } catch {
      return { output: `File not found: ${args.path}. Use glob or list_dir to locate it.`, isError: true };
    }
    if (stat.isDirectory()) return { output: `${args.path} is a directory. Use list_dir.`, isError: true };
    const shown = displayPath(resolved.absolute, ctx);
    const extension = path.extname(resolved.real).toLowerCase();
    if (IMAGE_MIME[extension]) return readImage(resolved.real, shown, stat.size, ctx.acceptsImages === true);
    if (IMAGE_EXTENSIONS.has(extension)) {
      return { output: `${shown} is an image (${stat.size} bytes) in a format this tool cannot show; only PNG, JPEG, GIF and WebP are shown.` };
    }
    if (stat.size > MAX_READ_BYTES) return { output: `${shown} is ${stat.size} bytes, which is too large to read. Use grep to find the relevant part.`, isError: true };
    const buffer = await fs.readFile(resolved.real);
    if (looksBinary(buffer)) return { output: `${shown} is a binary file (${stat.size} bytes); not shown.` };
    ctx.session.readFiles.set(resolved.real, { mtimeMs: stat.mtimeMs, size: stat.size });
    const text = buffer.toString('utf8');
    if (!text) return { output: `${shown} is empty.` };
    // A notebook reads as its cells (with the ids notebook_edit uses), not
    // as JSON whose outputs can be megabytes of base64 images.
    if (isNotebookPath(resolved.real)) {
      try {
        const rendered = renderNotebook(parseNotebook(text));
        const budget = (ctx.outputCap ?? OUTPUT_CAPS.toolOutputBytes) - 200;
        return { output: rendered.length > budget ? `${rendered.slice(0, budget)}\n\n[Notebook truncated: use grep to find a cell.]` : rendered };
      } catch {
        // fail-open-ok: a .ipynb that is not a valid notebook is shown as the text it is.
      }
    }
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, args.offset ?? 1);
    if (start > lines.length) return { output: `${shown} has only ${lines.length} lines; offset ${start} is past the end.`, isError: true };
    const limit = Math.min(args.limit ?? OUTPUT_CAPS.readFileLines, OUTPUT_CAPS.readFileLines);
    const slice = lines.slice(start - 1, start - 1 + limit);
    let bytes = 0;
    const body: string[] = [];
    // Stop at the loop's output cap (less room for the note) so the model gets
    // whole lines and a "continue with offset=" rather than a cut-out middle.
    const budget = (ctx.outputCap ?? OUTPUT_CAPS.toolOutputBytes) - 200;
    for (const [index, line] of slice.entries()) {
      const clipped = line.length > OUTPUT_CAPS.readFileLineChars ? `${line.slice(0, OUTPUT_CAPS.readFileLineChars)}… [line truncated]` : line;
      bytes += Buffer.byteLength(clipped) + 8;
      if (bytes > budget && body.length) break;
      body.push(`${start + index}\t${clipped}`);
    }
    const end = start + body.length - 1;
    const notes = end < lines.length ? `\n\n[Showing lines ${start}-${end} of ${lines.length}. Continue with offset=${end + 1}.]` : '';
    return { output: `${body.join('\n')}${notes}` };
  },
});

/** The picture itself, for a model that can see it: the loop sends it with
 * the result (models/openai-client.ts toChatMessages), and the text says
 * what it is for any later model that cannot. */
async function readImage(file: string, shown: string, size: number, acceptsImages: boolean): Promise<ToolRunResult> {
  if (!acceptsImages) return { output: `${shown} is an image (${size} bytes), and the current model cannot see images.` };
  if (size > MAX_TOOL_IMAGE_BYTES) {
    return { output: `${shown} is an image of ${size} bytes, more than the ${MAX_TOOL_IMAGE_BYTES} a model is shown. Make a smaller copy (scale it down or convert it to JPEG) and read that.`, isError: true };
  }
  const buffer = await fs.readFile(file);
  const image = sniffImage(buffer);
  if (!image) return { output: `${shown} is named as an image but its content is not a PNG, JPEG, GIF or WebP image; not shown.`, isError: true };
  const pixels = image.width && image.height ? `, ${image.width}x${image.height}` : '';
  if (Math.max(image.width ?? 0, image.height ?? 0) > MAX_IMAGE_SIDE) {
    return { output: `${shown} is ${image.width}x${image.height} pixels, more than the ${MAX_IMAGE_SIDE} a side a model is shown. Make a smaller copy and read that.`, isError: true };
  }
  return {
    output: `${shown} is an image (${image.mimeType}${pixels}, ${size} bytes), attached for you to see.`,
    images: [{ mimeType: image.mimeType, data: buffer.toString('base64'), name: path.basename(file) }],
  };
}
