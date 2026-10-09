/** Jupyter notebooks (.ipynb): read as cells, edited a cell at a time.
 *
 * A notebook is JSON whose outputs can be megabytes of base64 images, so
 * read_file shows it as its cells instead (renderNotebook), each headed by the
 * id notebook_edit addresses it with. notebook_edit mirrors Claude Code's
 * NotebookEdit: replace a cell's source, insert a new cell after one (or at
 * the top), or delete one. Replacing a code cell clears its outputs and
 * execution count, which would otherwise describe code that no longer exists. */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { eventDiff } from '../line-diff.js';
import { defineTool } from '../tool-contract.js';
import { displayPath, resolveForWrite } from './fs-helpers.js';
import { rememberWritten, writeTextAtomic } from './write-file.js';
import { formatToolRow } from '../../harness/protocol/tools.js';

type Json = Record<string, unknown>;
interface NotebookCell { cell_type: 'code' | 'markdown' | 'raw'; id?: string; source: string | string[]; metadata?: Json; outputs?: Json[]; execution_count?: number | null }
interface Notebook { cells: NotebookCell[]; nbformat?: number; nbformat_minor?: number; metadata?: Json }

const OUTPUT_PREVIEW_CHARS = 2000;

export function isNotebookPath(file: string): boolean {
  return file.toLowerCase().endsWith('.ipynb');
}

export function parseNotebook(text: string): Notebook {
  const parsed = JSON.parse(text) as Notebook;
  if (!parsed || !Array.isArray(parsed.cells)) throw new Error('not a Jupyter notebook (no "cells" array)');
  return parsed;
}

function sourceText(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

/** nbformat stores source as lines that keep their newline, the last without one. */
function sourceLines(text: string): string[] {
  const parts = text.split('\n');
  const lines = parts.map((line, index) => (index < parts.length - 1 ? `${line}\n` : line));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The id a cell is addressed by: its own `id`, else its position. */
export function cellKey(cell: NotebookCell, index: number): string {
  return typeof cell.id === 'string' && cell.id ? cell.id : `cell-${index}`;
}

function outputText(output: Json): string {
  if (output.output_type === 'stream') return sourceText((output.text as string | string[]) ?? '');
  if (output.output_type === 'error') return `${String(output.ename ?? 'Error')}: ${String(output.evalue ?? '')}`;
  const data = output.data as Json | undefined;
  if (data?.['text/plain']) return sourceText(data['text/plain'] as string | string[]);
  const kinds = data ? Object.keys(data).join(', ') : String(output.output_type ?? 'output');
  return `[${kinds}]`;
}

/** The notebook as the model reads it: one block per cell, headed by its id. */
export function renderNotebook(notebook: Notebook): string {
  if (!notebook.cells.length) return '(empty notebook)';
  return notebook.cells.map((cell, index) => {
    const head = `<cell id="${cellKey(cell, index)}" type="${cell.cell_type}">`;
    const outputs = (cell.outputs ?? []).map(outputText).join('\n').trim();
    const shown = outputs.length > OUTPUT_PREVIEW_CHARS ? `${outputs.slice(0, OUTPUT_PREVIEW_CHARS)}… [output truncated]` : outputs;
    return `${head}\n${sourceText(cell.source)}${shown ? `\n<output>\n${shown}\n</output>` : ''}\n</cell>`;
  }).join('\n\n');
}

interface NotebookEditArgs {
  path: string;
  cell_id?: string;
  new_source?: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

/** Pure: the notebook after one edit, or an error message. */
export function editNotebook(notebook: Notebook, args: NotebookEditArgs): { notebook: Notebook; summary: string } | { error: string } {
  const mode = args.edit_mode ?? 'replace';
  const cells = [...notebook.cells];
  const index = args.cell_id === undefined ? -1 : cells.findIndex((cell, i) => cellKey(cell, i) === args.cell_id);
  if (args.cell_id !== undefined && index < 0) return { error: `No cell "${args.cell_id}". Read the notebook to see its cell ids.` };
  if (mode === 'delete') {
    if (index < 0) return { error: 'delete needs the cell_id to remove.' };
    cells.splice(index, 1);
    return { notebook: { ...notebook, cells }, summary: `Deleted cell ${args.cell_id}.` };
  }
  if (typeof args.new_source !== 'string') return { error: `${mode} needs new_source.` };
  if (mode === 'insert') {
    const type = args.cell_type ?? 'code';
    const cell: NotebookCell = {
      cell_type: type, metadata: {}, source: sourceLines(args.new_source),
      // Ids are required from nbformat 4.5; older notebooks do not carry them.
      ...((notebook.nbformat ?? 4) > 4 || (notebook.nbformat_minor ?? 0) >= 5 ? { id: randomUUID().slice(0, 8) } : {}),
      ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
    };
    cells.splice(index + 1, 0, cell);
    return { notebook: { ...notebook, cells }, summary: `Inserted a ${type} cell ${index < 0 ? 'at the top' : `after ${args.cell_id}`}.` };
  }
  if (index < 0) return { error: 'replace needs the cell_id to change.' };
  const old = cells[index]!;
  const type = args.cell_type ?? old.cell_type;
  const replaced: NotebookCell = { ...old, cell_type: type, source: sourceLines(args.new_source) };
  if (type === 'code') { replaced.outputs = []; replaced.execution_count = null; } else { delete replaced.outputs; delete replaced.execution_count; }
  cells[index] = replaced;
  return { notebook: { ...notebook, cells }, summary: `Replaced cell ${args.cell_id}${type !== old.cell_type ? ` (now ${type})` : ''}.` };
}

export const notebookEditTool = defineTool<NotebookEditArgs>({
  name: 'notebook_edit',
  class: 'write',
  description: 'Edit a Jupyter notebook (.ipynb) one cell at a time: replace a cell\'s source, insert a new cell after a cell (or at the top when cell_id is omitted), or delete a cell. Read the notebook first to see its cell ids.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: { type: 'string', description: 'The .ipynb file.' },
      cell_id: { type: 'string', description: 'The cell to change, as read_file shows it. For insert: the cell to insert after; omit to insert at the top.' },
      new_source: { type: 'string', description: 'The cell\'s new source (replace, insert).' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'The cell\'s type. Required to insert a markdown cell; default code.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace.' },
    },
  },
  label: (args) => formatToolRow('notebook_edit', `${args.path}${args.cell_id ? ` (${args.cell_id})` : ''}`, 'edit'),
  paths: (args) => [args.path],
  async run(args, ctx) {
    if (!isNotebookPath(args.path)) return { output: `${args.path} is not a .ipynb notebook. Use edit_file for other files.`, isError: true };
    const resolved = resolveForWrite(args.path, ctx);
    let raw: string;
    try {
      raw = await fs.readFile(resolved.real, 'utf8');
    } catch {
      return { output: `Notebook not found: ${args.path}.`, isError: true };
    }
    if (!ctx.session.readFiles.has(resolved.real)) {
      return { output: `${args.path} has not been read in this session. Read it first to see its cells.`, isError: true };
    }
    let notebook: Notebook;
    try {
      notebook = parseNotebook(raw);
    } catch (error) {
      return { output: `${args.path}: ${(error as Error).message}.`, isError: true };
    }
    const edited = editNotebook(notebook, args);
    if ('error' in edited) return { output: edited.error, isError: true };
    const mode = (await fs.stat(resolved.real)).mode & 0o7777;
    await ctx.checkpoints.snapshot(ctx.checkpoint?.sessionId ?? ctx.sessionId, ctx.checkpoint?.turnId ?? ctx.turnId, resolved.real);
    // Jupyter writes one-space indentation and a trailing newline.
    await writeTextAtomic(resolved.real, `${JSON.stringify(edited.notebook, null, 1)}\n`, mode);
    await rememberWritten(resolved.real, ctx);
    return {
      output: `${edited.summary} ${displayPath(resolved.absolute, ctx)} now has ${edited.notebook.cells.length} cells.`,
      diff: eventDiff(renderNotebook(notebook), renderNotebook(edited.notebook), { numbered: true }),
    };
  },
});
