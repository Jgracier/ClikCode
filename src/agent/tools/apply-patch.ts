/** `apply_patch`: the patch format Codex-trained models write
 * (`*** Begin Patch` … `*** End Patch`), applied through the same path guards,
 * snapshots (so /undo works) and approval as write_file and edit_file. Every
 * file is prepared in memory first: a patch that does not apply changes nothing. */
import fs from 'node:fs/promises';
import { eventDiff } from '../line-diff.js';
import { defineTool, type ToolContext } from '../tool-contract.js';
import { displayPath, resolveForWrite, ToolInputError } from './fs-helpers.js';
import { readExisting, rememberWritten, writeTextAtomic } from './write-file.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { errorsAfterEdit } from './lsp.js';

interface ApplyPatchArgs { patch: string }

type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

interface Hunk { header?: string; lines: Array<{ op: ' ' | '-' | '+'; text: string }>; atEnd: boolean }

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';

/** The patch as operations. Throws ToolInputError naming the line it could not read. */
export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines[0]?.trim() !== BEGIN) throw new ToolInputError(`The patch must start with "${BEGIN}".`);
  if (lines[lines.length - 1]?.trim() !== END) throw new ToolInputError(`The patch must end with "${END}".`);
  const body = lines.slice(1, -1);
  const ops: PatchOp[] = [];
  let index = 0;
  const fail = (message: string): never => { throw new ToolInputError(`Patch line ${index + 2}: ${message}`); };
  while (index < body.length) {
    const line = body[index]!;
    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    const update = /^\*\*\* Update File: (.+)$/.exec(line);
    if (add) {
      const added: string[] = [];
      index += 1;
      while (index < body.length && !body[index]!.startsWith('*** ')) {
        const text = body[index]!;
        if (!text.startsWith('+')) fail('a line of an added file must start with "+".');
        added.push(text.slice(1));
        index += 1;
      }
      ops.push({ kind: 'add', path: add[1]!.trim(), lines: added });
    } else if (del) {
      ops.push({ kind: 'delete', path: del[1]!.trim() });
      index += 1;
    } else if (update) {
      const op: Extract<PatchOp, { kind: 'update' }> = { kind: 'update', path: update[1]!.trim(), hunks: [] };
      index += 1;
      const move = /^\*\*\* Move to: (.+)$/.exec(body[index] ?? '');
      if (move) { op.moveTo = move[1]!.trim(); index += 1; }
      let hunk: Hunk | undefined;
      while (index < body.length && !/^\*\*\* (Add|Delete|Update) File: /.test(body[index]!)) {
        const text = body[index]!;
        if (text.startsWith('@@')) {
          hunk = { header: text.slice(2).trim() || undefined, lines: [], atEnd: false };
          op.hunks.push(hunk);
        } else if (text === '*** End of File') {
          if (hunk) hunk.atEnd = true;
        } else {
          // A first hunk may omit its "@@" line.
          if (!hunk) { hunk = { lines: [], atEnd: false }; op.hunks.push(hunk); }
          const mark = text[0];
          if (text === '') hunk.lines.push({ op: ' ', text: '' });
          else if (mark === ' ' || mark === '-' || mark === '+') hunk.lines.push({ op: mark, text: text.slice(1) });
          else fail(`expected a line starting with " ", "-" or "+", got "${text.slice(0, 40)}".`);
        }
        index += 1;
      }
      if (!op.hunks.length && !op.moveTo) fail(`"${op.path}" has no changes.`);
      ops.push(op);
    } else {
      fail(`expected "*** Add File:", "*** Delete File:" or "*** Update File:", got "${line.slice(0, 40)}".`);
    }
  }
  if (!ops.length) throw new ToolInputError('The patch has no files in it.');
  return ops;
}

/** Where `want` begins in `lines` at or after `from`: exact first, then
 * ignoring trailing space, then ignoring indentation as well. */
function seek(lines: readonly string[], want: readonly string[], from: number, atEnd: boolean): number {
  if (!want.length) return atEnd ? lines.length : from;
  const same: Array<(a: string, b: string) => boolean> = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()];
  for (const equal of same) {
    const last = lines.length - want.length;
    const order = atEnd ? [last] : Array.from({ length: Math.max(0, last - from + 1) }, (_, offset) => from + offset);
    for (const start of order) {
      if (start < from || start < 0) continue;
      if (want.every((line, offset) => equal(lines[start + offset]!, line))) return start;
    }
  }
  return -1;
}

function applyHunks(original: string, hunks: readonly Hunk[], shown: string): string {
  const crlf = (original.match(/\r\n/g)?.length ?? 0) > (original.match(/(?<!\r)\n/g)?.length ?? 0);
  const text = original.replace(/\r\n/g, '\n');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  let cursor = 0;
  let copied = 0;
  const out: string[] = [];
  for (const hunk of hunks) {
    if (hunk.header) {
      const at = seek(lines, [hunk.header], cursor, false);
      if (at >= 0) cursor = at + 1;
    }
    const before = hunk.lines.filter((line) => line.op !== '+').map((line) => line.text);
    const after = hunk.lines.filter((line) => line.op !== '-').map((line) => line.text);
    const at = seek(lines, before, cursor, hunk.atEnd);
    if (at < 0) {
      throw new ToolInputError(`${shown}: the lines to change were not found${hunk.header ? ` after "${hunk.header}"` : ''}:\n${before.slice(0, 6).join('\n')}\nRe-read the file and give the lines exactly as they are.`);
    }
    out.push(...lines.slice(copied, at), ...after);
    cursor = at + before.length;
    copied = cursor;
  }
  out.push(...lines.slice(copied));
  const joined = out.join('\n') + (endsWithNewline || !original ? '\n' : '');
  return crlf ? joined.replace(/\n/g, '\r\n') : joined;
}

interface Change { real: string; shown: string; before: string; after: string | undefined; mode?: number; move?: { real: string; shown: string } }

async function prepare(patch: string, ctx: ToolContext): Promise<Change[]> {
  const changes: Change[] = [];
  const touched = new Set<string>();
  const claim = (real: string, shown: string): void => {
    if (touched.has(real)) throw new ToolInputError(`${shown} appears twice in the patch. Put every change to a file in one section.`);
    touched.add(real);
  };
  for (const op of parsePatch(patch)) {
    const resolved = resolveForWrite(op.path, ctx);
    const shown = displayPath(resolved.absolute, ctx);
    claim(resolved.real, shown);
    const existing = await readExisting(resolved.real);
    if (op.kind === 'add') {
      if (existing) throw new ToolInputError(`${shown} already exists. Use "*** Update File:" to change it.`);
      changes.push({ real: resolved.real, shown, before: '', after: op.lines.length ? `${op.lines.join('\n')}\n` : '' });
    } else if (op.kind === 'delete') {
      if (!existing) throw new ToolInputError(`${shown} does not exist, so it cannot be deleted.`);
      changes.push({ real: resolved.real, shown, before: existing.text, after: undefined, mode: existing.mode });
    } else {
      if (!existing) throw new ToolInputError(`${shown} does not exist. Use "*** Add File:" to create it.`);
      const after = op.hunks.length ? applyHunks(existing.text, op.hunks, shown) : existing.text;
      let move: Change['move'];
      if (op.moveTo) {
        const target = resolveForWrite(op.moveTo, ctx);
        const targetShown = displayPath(target.absolute, ctx);
        claim(target.real, targetShown);
        if (await readExisting(target.real)) throw new ToolInputError(`${targetShown} already exists, so ${shown} cannot be moved onto it.`);
        move = { real: target.real, shown: targetShown };
      }
      changes.push({ real: resolved.real, shown, before: existing.text, after, mode: existing.mode, ...(move ? { move } : {}) });
    }
  }
  return changes;
}

const diffOf = (changes: readonly Change[]) => changes.flatMap((change) => eventDiff(change.before, change.after ?? '', { path: change.move?.shown ?? change.shown, numbered: true }));

/** The files the patch names, for confinement and approval; a patch that does not parse names none (run reports it). */
function patchPaths(args: ApplyPatchArgs): string[] {
  try {
    return parsePatch(String(args.patch ?? '')).flatMap((op) => (op.kind === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path]));
  } catch { return []; }
}

export const applyPatchTool = defineTool<ApplyPatchArgs>({
  name: 'apply_patch',
  class: 'write',
  description: [
    'Edit files with a patch. The patch starts with "*** Begin Patch" and ends with "*** End Patch"; between them, one section per file:',
    '"*** Add File: <path>" followed by the new contents, every line starting with "+";',
    '"*** Delete File: <path>";',
    '"*** Update File: <path>" (optionally followed by "*** Move to: <new path>") followed by hunks. A hunk starts with "@@" (optionally with a line of the file to find it by, such as a function signature); its lines start with " " (unchanged), "-" (removed) or "+" (added). Give 3 lines of unchanged context around each change.',
    'Paths are relative to the working directory. Either every file is changed or none is.',
  ].join('\n'),
  parameters: {
    type: 'object', additionalProperties: false, required: ['patch'],
    properties: { patch: { type: 'string', description: 'The whole patch, from "*** Begin Patch" to "*** End Patch".' } },
  },
  label: (args) => formatToolRow('apply_patch', patchPaths(args).join(', ') || 'patch', 'edit'),
  paths: patchPaths,
  async preview(args, ctx) { return diffOf(await prepare(String(args.patch ?? ''), ctx)); },
  async run(args, ctx) {
    const changes = await prepare(String(args.patch ?? ''), ctx);
    const session = ctx.checkpoint?.sessionId ?? ctx.sessionId;
    const turn = ctx.checkpoint?.turnId ?? ctx.turnId;
    let errors = '';
    for (const change of changes) {
      await ctx.checkpoints.snapshot(session, turn, change.real);
      if (change.move) await ctx.checkpoints.snapshot(session, turn, change.move.real);
      if (change.after === undefined) {
        await fs.rm(change.real);
        ctx.session.readFiles.delete(change.real);
        continue;
      }
      const target = change.move?.real ?? change.real;
      await writeTextAtomic(target, change.after, change.mode);
      if (change.move) { await fs.rm(change.real); ctx.session.readFiles.delete(change.real); }
      await rememberWritten(target, ctx);
      errors += await errorsAfterEdit(target, ctx);
    }
    const names = changes.map((change) => `${change.after === undefined ? 'deleted ' : change.before === '' && !change.move ? 'added ' : 'updated '}${change.move ? `${change.shown} -> ${change.move.shown}` : change.shown}`);
    return { output: `Applied the patch: ${names.join(', ')}.${errors}`, diff: diffOf(changes) };
  },
});
