/** `task`: hands one self-contained research question to a sub-agent and
 * returns its answer and the path to its durable trace, so the parent's
 * context pays for the conclusion unless it needs the details.
 *
 * Read-only calls can run in parallel. Coding subagents use the separate
 * `agent` tool, which runs serially and shares the parent's undo checkpoint
 * unless it is isolated in its own git worktree. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { resolveAgentType } from '../plugins.js';

interface TaskArgs { prompt: string; description?: string; model?: string; subagent_type?: string }

export const TASK_TOOL_NAME = 'task';

export const taskTool = defineTool<TaskArgs>({
  name: TASK_TOOL_NAME,
  class: 'read',
  description: [
    'Start a read-only sub-agent for one research question: finding where something is implemented, tracing a flow across files, summarizing a directory or a web page.',
    'It sees none of this conversation, so the prompt must be self-contained: say what to find, where to look, and what the answer should contain.',
    'It can read, list, glob, grep and fetch, but cannot edit files or run commands. Its answer includes a path to its tool trace.',
    'Several task calls in one step run in parallel; use that for independent questions.',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The complete task for the sub-agent.' },
      description: { type: 'string', description: 'A 3-6 word label shown to the user, e.g. "Find the retry logic".' },
      subagent_type: { type: 'string', description: 'An agent type listed under Agent types in the system prompt, when one fits. Omit for the general research sub-agent.' },
      model: { type: 'string', description: 'One model id from the swarm list, copied exactly, when this conversation has a swarm. Do not invent a model. Match the index to the task and prefer the cheaper price when a lower index is enough.' },
    },
  },
  label: (args) => formatToolRow('task', args.description?.trim() || args.prompt),
  async run(args, ctx) {
    // Absent inside a sub-agent: one level of delegation, never a tree.
    if (!ctx.runSubagent) return { output: 'A sub-agent cannot start sub-agents. Do this research yourself with the tools you have.', isError: true };
    const type = resolveAgentType({ stateDir: ctx.stateDir, home: ctx.homeDir }, args.subagent_type);
    if ('error' in type) return { output: type.error, isError: true };
    return ctx.runSubagent({
      prompt: args.prompt, ...type,
      ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    });
  },
});
