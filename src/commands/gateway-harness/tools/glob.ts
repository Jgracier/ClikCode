import fs from 'node:fs/promises';
import { matchGlob } from '../glob-match.js';
import { defineTool } from '../types.js';
import { displayPath, resolveForRead, walkFiles } from './fs-helpers.js';

interface GlobArgs { pattern: string; path?: string }

const MAX_RESULTS = 200;

export const globTool = defineTool<GlobArgs>({
  name: 'glob',
  class: 'read',
  description: 'Find files by glob pattern (e.g. `src/**/*.ts`, `*.{json,yaml}`). Returns paths, most recently modified first. Skips .git, node_modules and gitignored files.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to `path`.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
    },
  },
  label: (args) => `Glob ${args.pattern}`,
  paths: (args) => [args.path ?? '.'],
  async run(args, ctx) {
    const root = resolveForRead(args.path ?? '.', ctx);
    const matches: { file: string; mtimeMs: number }[] = [];
    let total = 0;
    for await (const file of walkFiles(root.real, { signal: ctx.signal, includeHidden: args.pattern.includes('/.') || args.pattern.startsWith('.') })) {
      if (!matchGlob(args.pattern, file.relative)) continue;
      total++;
      if (matches.length >= 5000) continue;
      let mtimeMs = 0;
      try { mtimeMs = (await fs.stat(file.absolute)).mtimeMs; } catch { /* raced with a delete */ }
      matches.push({ file: file.absolute, mtimeMs });
    }
    if (!total) return { output: `No files match ${args.pattern}.` };
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = matches.slice(0, MAX_RESULTS).map((match) => displayPath(match.file, ctx));
    return { output: [...shown, ...(total > shown.length ? [`… ${total - shown.length} more matches; narrow the pattern.`] : [])].join('\n') };
  },
});
