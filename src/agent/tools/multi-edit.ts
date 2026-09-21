import { eventDiff, renderDiffPreview } from '../line-diff.js';
import { defineTool } from '../tool-contract.js';
import { commitEdit, prepareEdits, type EditOperation } from './edit-file.js';

interface MultiEditArgs { path: string; edits: EditOperation[] }

export const multiEditTool = defineTool<MultiEditArgs>({
  name: 'multi_edit',
  class: 'write',
  description: 'Apply several exact-string edits to ONE file atomically, in order (each edit sees the result of the previous one). If any edit fails, none are applied. Same matching rules as edit_file.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['path', 'edits'],
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['old_string', 'new_string'],
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
        },
      },
    },
  },
  label: (args) => `Edit ${args.path} (${args.edits.length} changes)`,
  paths: (args) => [args.path],
  async preview(args, ctx) {
    const prepared = await prepareEdits(args.path, args.edits, ctx, false);
    return renderDiffPreview(prepared.before, prepared.after);
  },
  async run(args, ctx) {
    // All edits are computed in memory first; the single write below is the
    // only mutation, which is what makes the batch all-or-nothing.
    const prepared = await prepareEdits(args.path, args.edits, ctx);
    await commitEdit(prepared, ctx);
    return { output: `Applied ${args.edits.length} edit(s) to ${prepared.shown}.`, diff: eventDiff(prepared.before, prepared.after) };
  },
});
