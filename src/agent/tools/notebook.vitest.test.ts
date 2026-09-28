import { describe, expect, it } from 'vitest';
import { editNotebook, parseNotebook, renderNotebook } from './notebook.js';

const nb = () => parseNotebook(JSON.stringify({
  nbformat: 4, nbformat_minor: 5, metadata: {},
  cells: [
    { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Title\n', 'Some text'] },
    { cell_type: 'code', id: 'calc', metadata: {}, source: ['x = 41\n', 'x + 1'], execution_count: 3,
      outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['42'], 'image/png': 'iVBOR...' } }] },
  ],
}));

describe('a Jupyter notebook', () => {
  it('reads as its cells, with ids and text outputs, never the embedded image data', () => {
    const shown = renderNotebook(nb());
    expect(shown).toContain('<cell id="intro" type="markdown">\n# Title\nSome text\n</cell>');
    expect(shown).toContain('<cell id="calc" type="code">\nx = 41\nx + 1\n<output>\n42\n</output>');
    expect(shown).not.toContain('iVBOR');
  });

  it('replaces a code cell and clears its now-stale outputs', () => {
    const edited = editNotebook(nb(), { path: 'n.ipynb', cell_id: 'calc', new_source: 'x = 1\nx * 2' });
    if ('error' in edited) throw new Error(edited.error);
    const cell = edited.notebook.cells[1]!;
    expect(cell.source).toEqual(['x = 1\n', 'x * 2']);
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
  });

  it('inserts after a cell or at the top, and deletes by id', () => {
    const inserted = editNotebook(nb(), { path: 'n.ipynb', cell_id: 'intro', new_source: '## Notes\n', cell_type: 'markdown', edit_mode: 'insert' });
    if ('error' in inserted) throw new Error(inserted.error);
    expect(inserted.notebook.cells.map((c) => c.cell_type)).toEqual(['markdown', 'markdown', 'code']);
    expect(typeof inserted.notebook.cells[1]!.id).toBe('string');
    const top = editNotebook(nb(), { path: 'n.ipynb', new_source: 'import os', edit_mode: 'insert' });
    if ('error' in top) throw new Error(top.error);
    expect(top.notebook.cells[0]).toMatchObject({ cell_type: 'code', source: ['import os'], outputs: [] });
    const deleted = editNotebook(nb(), { path: 'n.ipynb', cell_id: 'intro', edit_mode: 'delete' });
    if ('error' in deleted) throw new Error(deleted.error);
    expect(deleted.notebook.cells.map((c) => c.id)).toEqual(['calc']);
  });

  it('refuses an unknown cell and a replace with no source', () => {
    expect(editNotebook(nb(), { path: 'n.ipynb', cell_id: 'nope', new_source: 'x' })).toEqual({ error: expect.stringContaining('No cell "nope"') });
    expect(editNotebook(nb(), { path: 'n.ipynb', cell_id: 'calc' })).toEqual({ error: 'replace needs new_source.' });
  });
});
