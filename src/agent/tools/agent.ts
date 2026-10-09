/** A coding subagent runs the same local tools with the parent's approvals.
 * Its write class makes the parent run it alone, in call order. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';

interface AgentArgs { prompt: string; description?: string }

export const agentTool = defineTool<AgentArgs>({
  name: 'agent',
  class: 'write',
  description: 'Delegate a self-contained coding task to a subagent. It can read, edit and run commands under this conversation\'s permissions. Its file edits belong to this turn\'s undo checkpoint. It sees the project instructions but not this conversation; include the task, files, constraints and expected result. It runs serially with other writes.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'Complete coding task for the subagent.' },
      description: { type: 'string', description: 'Short label shown to the user.' },
    },
  },
  label: (args) => formatToolRow('agent', args.description?.trim() || args.prompt),
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'A subagent cannot start another subagent.', isError: true };
    return ctx.runSubagent({ prompt: args.prompt, kind: 'work', ...(args.description?.trim() ? { description: args.description.trim() } : {}) });
  },
});
