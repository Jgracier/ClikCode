/** `task`: hands one self-contained research question to a sub-agent and
 * returns only its answer, so the parent's context pays for the conclusion
 * instead of every file the sub-agent read on the way.
 *
 * Read-only on purpose, and there is no write-capable variant:
 * - Its class is `read`, which is what lets several task calls in one step
 *   run in parallel. A writer would have to be sequential and would need a
 *   second tool.
 * - File checkpoints (undo) are keyed by turn; a sub-agent runs its own turn,
 *   so its edits would fall outside the parent turn's undo.
 * - The read-before-edit guard is per session; a sub-agent's reads would not
 *   vouch for the parent's edits, nor the reverse.
 * - An approval prompt raised from a context the user never sees asks them to
 *   approve a change without the reasoning behind it.
 * Edits stay with the parent, which can act on the sub-agent's findings. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';

interface TaskArgs { prompt: string; description?: string }

export const TASK_TOOL_NAME = 'task';

export const taskTool = defineTool<TaskArgs>({
  name: TASK_TOOL_NAME,
  class: 'read',
  description: [
    'Start a read-only sub-agent for one research question: finding where something is implemented, tracing a flow across files, summarizing a directory or a web page.',
    'It sees none of this conversation, so the prompt must be self-contained: say what to find, where to look, and what the answer should contain.',
    'It can read, list, glob, grep and fetch, but cannot edit files or run commands. Only its final answer comes back.',
    'Several task calls in one step run in parallel; use that for independent questions.',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The complete task for the sub-agent.' },
      description: { type: 'string', description: 'A 3-6 word label shown to the user, e.g. "Find the retry logic".' },
    },
  },
  label: (args) => formatToolRow('task', args.description?.trim() || args.prompt),
  async run(args, ctx) {
    // Absent inside a sub-agent: one level of delegation, never a tree.
    if (!ctx.runSubagent) return { output: 'A sub-agent cannot start sub-agents. Do this research yourself with the tools you have.', isError: true };
    return ctx.runSubagent({ prompt: args.prompt, ...(args.description?.trim() ? { description: args.description.trim() } : {}) });
  },
});
