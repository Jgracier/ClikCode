import fs from 'node:fs/promises';
import path from 'node:path';
import { eventDiff, renderDiffPreview } from '../line-diff.js';
import { defineTool, type ToolContext } from '../types.js';
import { displayPath, looksBinary, resolveForWrite } from './fs-helpers.js';

interface WriteFileArgs { path: string; content: string }

async function readExisting(file: string): Promise<{ text: string; mode: number; mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    const buffer = await fs.readFile(file);
    if (looksBinary(buffer)) throw new Error(`${file} is a binary file and cannot be edited with text tools`);
    return { text: buffer.toString('utf8'), mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Write through a sibling temp file so a crash never leaves a half file,
 * keeping the original permission bits. */
export async function writeTextAtomic(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.clikcode-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, content, { mode: mode ?? 0o644 });
    if (mode !== undefined) await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function rememberWritten(file: string, ctx: ToolContext): Promise<void> {
  const stat = await fs.stat(file);
  ctx.session.readFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
}

export const writeFileTool = defineTool<WriteFileArgs>({
  name: 'write_file',
  class: 'write',
  description: 'Create a file or replace its entire contents. To change part of an existing file use edit_file instead. An existing file must have been read first.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      content: { type: 'string', description: 'Complete new file contents.' },
    },
  },
  label: (args) => `Write ${args.path}`,
  paths: (args) => [args.path],
  async preview(args, ctx) {
    const existing = await readExisting(resolveForWrite(args.path, ctx).real);
    return existing ? renderDiffPreview(existing.text, args.content) : `(new file, ${args.content.split('\n').length} lines)\n${renderDiffPreview('', args.content, { maxLines: 40 })}`;
  },
  async run(args, ctx) {
    const resolved = resolveForWrite(args.path, ctx);
    const existing = await readExisting(resolved.real);
    if (existing && !ctx.session.readFiles.has(resolved.real)) {
      return { output: `${args.path} already exists but has not been read in this session. Read it first so you do not overwrite content you have not seen.`, isError: true };
    }
    await ctx.checkpoints.snapshot(ctx.sessionId, ctx.turnId, resolved.real);
    await writeTextAtomic(resolved.real, args.content, existing?.mode);
    await rememberWritten(resolved.real, ctx);
    const shown = displayPath(resolved.absolute, ctx);
    return {
      output: existing ? `Overwrote ${shown} (${args.content.length} characters).` : `Created ${shown} (${args.content.length} characters).`,
      diff: eventDiff(existing?.text ?? '', args.content),
    };
  },
});

export { readExisting };
