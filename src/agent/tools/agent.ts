/** A coding subagent runs the same local tools with the parent's approvals.
 * Its write class makes the parent run it alone, in call order -- unless it
 * is isolated in its own git worktree, where it touches nothing the parent's
 * other calls can see, so several run at once. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';

interface AgentArgs { prompt: string; description?: string; isolation?: 'worktree' }

export const agentTool = defineTool<AgentArgs>({
  name: 'agent',
  class: 'write',
  description: [
    'Delegate a self-contained coding task to a subagent. It can read, edit and run commands under this conversation\'s permissions.',
    'It sees the project instructions but not this conversation; include the task, files, constraints and expected result.',
    'By default it works in this working tree, its file edits belong to this turn\'s undo checkpoint, and it runs serially with other writes.',
    'With isolation "worktree" (git repositories only) it works in a fresh git worktree on a new branch from HEAD, without this tree\'s uncommitted changes; its result names the branch and summarizes the diff (a worktree with no changes is removed). Several isolated agent calls in one step run in parallel.',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'Complete coding task for the subagent.' },
      description: { type: 'string', description: 'Short label shown to the user.' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Run in its own git worktree and branch, so it can run in parallel with other agents.' },
    },
  },
  label: (args) => formatToolRow('agent', args.description?.trim() || args.prompt),
  concurrent: (args) => args?.isolation === 'worktree',
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'A subagent cannot start another subagent.', isError: true };
    return ctx.runSubagent({
      prompt: args.prompt, kind: 'work',
      ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      ...(args.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
    });
  },
});
