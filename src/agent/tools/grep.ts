/** Content search: system ripgrep when present, otherwise a Node walker that
 * honors .gitignore basics and skips VCS internals, node_modules and binaries. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { killProcessTreePortable, spawnPortable } from '../../harness/transport/spawn.js';
import { matchGlob } from '../glob-match.js';
import { capHeadTail } from '../security.js';
import { defineTool, type ToolContext } from '../types.js';
import { displayPath, looksBinary, resolveForRead, throwIfAborted, walkFiles } from './fs-helpers.js';

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: 'content' | 'files' | 'count';
  context?: number;
  head_limit?: number;
}

const DEFAULT_HEAD_LIMIT = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
let ripgrepAvailable: Promise<boolean> | undefined;

export function hasRipgrep(): Promise<boolean> {
  ripgrepAvailable ??= new Promise((resolve) => {
    try {
      const probe = spawnPortable('rg', ['--version'], { stdio: 'ignore' });
      probe.once('error', () => resolve(false));
      probe.once('exit', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
  return ripgrepAvailable;
}

function limitLines(lines: string[], limit: number): string {
  if (!lines.length) return 'No matches.';
  const shown = lines.slice(0, limit);
  return [...shown, ...(lines.length > shown.length ? [`… ${lines.length - shown.length} more lines; narrow the search or raise head_limit.`] : [])].join('\n');
}

export async function grepWithRipgrep(args: GrepArgs, root: string, ctx: Pick<ToolContext, 'signal' | 'cwd'>): Promise<{ output: string; isError?: boolean }> {
  const mode = args.output_mode ?? 'content';
  // --no-require-git: honor .gitignore even outside a git checkout, matching
  // the Node fallback. Hidden files are searched, VCS internals and
  // node_modules never are.
  const argv = ['--color', 'never', '--no-messages', '--max-filesize', '5M', '--no-require-git', '--hidden', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**'];
  if (mode === 'files') argv.push('--files-with-matches');
  else if (mode === 'count') argv.push('--count');
  else { argv.push('--line-number', '--no-heading', '--with-filename'); if (args.context) argv.push('--context', String(args.context)); }
  if (args.case_insensitive) argv.push('--ignore-case');
  if (args.glob) argv.push('--glob', args.glob);
  argv.push('--regexp', args.pattern, '--', root);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawnPortable('rg', argv, { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached });
    let stdout = '';
    let stderr = '';
    const abort = (): void => killProcessTreePortable(child, 'SIGKILL', detached);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) abort();
    });
    child.stderr!.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once('error', reject);
    child.once('close', (code) => {
      ctx.signal?.removeEventListener('abort', abort);
      if (ctx.signal?.aborted) return reject(Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' }));
      if (code === 2 && !stdout) return resolve({ output: `Search failed: ${stderr.trim() || 'invalid pattern'}`, isError: true });
      const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      const relativeRoot = path.relative(ctx.cwd, root);
      const shownRoot = relativeRoot === '' ? '' : !relativeRoot.startsWith('..') && !path.isAbsolute(relativeRoot) ? `${relativeRoot}${path.sep}` : prefix;
      const lines = stdout.split(/\r?\n/).filter(Boolean).map((line) => line.startsWith(prefix) ? `${shownRoot}${line.slice(prefix.length)}` : line);
      resolve({ output: limitLines(lines, args.head_limit ?? DEFAULT_HEAD_LIMIT) });
    });
  });
}

export async function grepWithNode(args: GrepArgs, root: string, ctx: Pick<ToolContext, 'signal' | 'cwd'>): Promise<{ output: string; isError?: boolean }> {
  let regex: RegExp;
  try { regex = new RegExp(args.pattern, args.case_insensitive ? 'i' : ''); } catch (error) {
    return { output: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  const mode = args.output_mode ?? 'content';
  const limit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const context = Math.max(0, Math.min(args.context ?? 0, 10));
  const out: string[] = [];
  const stat = await fs.stat(root);
  const files = stat.isFile()
    ? (async function* single() { yield { absolute: root, relative: path.basename(root) }; })()
    : walkFiles(root, { signal: ctx.signal, includeHidden: true });
  for await (const file of files) {
    throwIfAborted(ctx.signal);
    if (out.length > limit) break;
    if (args.glob && !matchGlob(args.glob, file.relative)) continue;
    let buffer: Buffer;
    try {
      if ((await fs.stat(file.absolute)).size > MAX_FILE_BYTES) continue;
      buffer = await fs.readFile(file.absolute);
    } catch { continue; }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    const shown = displayPath(file.absolute, ctx);
    const hits = lines.flatMap((line, index) => regex.test(line) ? [index] : []);
    if (!hits.length) continue;
    if (mode === 'files') { out.push(shown); continue; }
    if (mode === 'count') { out.push(`${shown}:${hits.length}`); continue; }
    const printed = new Set<number>();
    for (const hit of hits) {
      for (let index = Math.max(0, hit - context); index <= Math.min(lines.length - 1, hit + context); index++) {
        if (printed.has(index)) continue;
        printed.add(index);
        out.push(`${shown}${hits.includes(index) ? ':' : '-'}${index + 1}${hits.includes(index) ? ':' : '-'}${lines[index].slice(0, 500)}`);
      }
    }
  }
  return { output: limitLines(out, limit) };
}

export const grepTool = defineTool<GrepArgs>({
  name: 'grep',
  class: 'read',
  description: 'Search file contents with a regular expression. output_mode: `content` (file:line:text, default), `files` (paths only), `count`. Filter with `glob` (e.g. `*.ts`). Prefer this over running grep/rg through bash.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Regular expression.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Only search files matching this glob.' },
      case_insensitive: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
      context: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines of context around each match (content mode).' },
      head_limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum output lines (default 200).' },
    },
  },
  label: (args) => `Grep ${args.pattern}${args.glob ? ` in ${args.glob}` : ''}`,
  paths: (args) => [args.path ?? '.'],
  async run(args, ctx) {
    const root = resolveForRead(args.path ?? '.', ctx);
    try { await fs.stat(root.real); } catch { return { output: `Path not found: ${args.path}`, isError: true }; }
    const result = await hasRipgrep() ? await grepWithRipgrep(args, root.real, ctx) : await grepWithNode(args, root.real, ctx);
    return { ...result, output: capHeadTail(result.output).text };
  },
});
