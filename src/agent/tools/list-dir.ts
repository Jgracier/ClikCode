import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '../tool-contract.js';
import { displayPath, resolveForRead } from './fs-helpers.js';

interface ListDirArgs { path?: string }

const MAX_ENTRIES = 500;

export const listDirTool = defineTool<ListDirArgs>({
  name: 'list_dir',
  class: 'read',
  description: 'List one directory (non-recursive). Directories end with `/`. Use glob to search recursively.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string', description: 'Directory to list. Defaults to the working directory.' } },
  },
  label: (args) => `List ${args.path ?? '.'}`,
  paths: (args) => [args.path ?? '.'],
  async run(args, ctx) {
    const resolved = resolveForRead(args.path ?? '.', ctx);
    let entries;
    try { entries = await fs.readdir(resolved.real, { withFileTypes: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { output: code === 'ENOTDIR' ? `${args.path} is a file. Use read_file.` : `Cannot list ${args.path ?? '.'}: ${code ?? 'error'}`, isError: true };
    }
    const names = entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`)
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    const shown = names.slice(0, MAX_ENTRIES);
    const header = `${displayPath(resolved.absolute, ctx) || path.basename(resolved.absolute)} (${names.length} entries)`;
    return { output: [header, ...shown, ...(names.length > shown.length ? [`… ${names.length - shown.length} more`] : [])].join('\n') };
  },
});
