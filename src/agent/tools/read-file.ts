import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_CAPS } from '../security.js';
import { defineTool } from '../tool-contract.js';
import { displayPath, IMAGE_EXTENSIONS, looksBinary, resolveForRead } from './fs-helpers.js';

interface ReadFileArgs { path: string; offset?: number; limit?: number }

const MAX_READ_BYTES = 20 * 1024 * 1024;

export const readFileTool = defineTool<ReadFileArgs>({
  name: 'read_file',
  class: 'read',
  description: 'Read a text file. Returns numbered lines (`N\\tline`). Reads up to 2000 lines from the start by default; use offset (1-based line) and limit for large files. Always read a file before editing it.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
    },
  },
  label: (args) => `Read ${args.path}`,
  paths: (args) => [args.path],
  async run(args, ctx) {
    const resolved = resolveForRead(args.path, ctx);
    let stat;
    try { stat = await fs.stat(resolved.real); } catch {
      return { output: `File not found: ${args.path}. Use glob or list_dir to locate it.`, isError: true };
    }
    if (stat.isDirectory()) return { output: `${args.path} is a directory. Use list_dir.`, isError: true };
    const shown = displayPath(resolved.absolute, ctx);
    if (IMAGE_EXTENSIONS.has(path.extname(resolved.real).toLowerCase())) {
      return { output: `${shown} is an image (${stat.size} bytes). Image content cannot be read as text by this tool.` };
    }
    if (stat.size > MAX_READ_BYTES) return { output: `${shown} is ${stat.size} bytes, which is too large to read. Use grep to find the relevant part.`, isError: true };
    const buffer = await fs.readFile(resolved.real);
    if (looksBinary(buffer)) return { output: `${shown} is a binary file (${stat.size} bytes); not shown.` };
    ctx.session.readFiles.set(resolved.real, { mtimeMs: stat.mtimeMs, size: stat.size });
    const text = buffer.toString('utf8');
    if (!text) return { output: `${shown} is empty.` };
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, args.offset ?? 1);
    if (start > lines.length) return { output: `${shown} has only ${lines.length} lines; offset ${start} is past the end.`, isError: true };
    const limit = Math.min(args.limit ?? OUTPUT_CAPS.readFileLines, OUTPUT_CAPS.readFileLines);
    const slice = lines.slice(start - 1, start - 1 + limit);
    let bytes = 0;
    const body: string[] = [];
    for (const [index, line] of slice.entries()) {
      const clipped = line.length > OUTPUT_CAPS.readFileLineChars ? `${line.slice(0, OUTPUT_CAPS.readFileLineChars)}… [line truncated]` : line;
      bytes += clipped.length + 8;
      if (bytes > 256 * 1024) break;
      body.push(`${start + index}\t${clipped}`);
    }
    const end = start + body.length - 1;
    const notes = end < lines.length ? `\n\n[Showing lines ${start}-${end} of ${lines.length}. Continue with offset=${end + 1}.]` : '';
    return { output: `${body.join('\n')}${notes}` };
  },
});
