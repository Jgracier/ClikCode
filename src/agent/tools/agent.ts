/** A coding subagent runs the same local tools with the parent's approvals.
 * Its write class makes the parent run it alone, in call order -- unless it
 * is isolated in its own git worktree, where it touches nothing the parent's
 * other calls can see, so several run at once. A background agent is always
 * isolated, and agent_send / agent_wait reach it while it runs. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { canCreateAgentWorktree, noWorktreeMessage } from '../worktree.js';
import { resolveAgentType } from '../plugins.js';

interface AgentArgs { prompt: string; description?: string; isolation?: 'worktree'; background?: boolean; subagent_type?: string; repo?: string }

/** `repo` as an absolute directory, or the reason it cannot be used. It must lie inside the session's own
 * directories: a worktree is created from it, which writes into that repository's .git. */
function resolveRepo(repo: string | undefined, cwd: string, addDirs: readonly string[]): { dir?: string; error?: string } {
  if (repo === undefined) return {};
  const dir = path.resolve(cwd, repo);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `repo ${dir} is not a directory.` };
  const real = fs.realpathSync(dir);
  const inside = [cwd, ...addDirs].some((root) => { const rel = path.relative(fs.existsSync(root) ? fs.realpathSync(root) : root, real); return !rel.startsWith('..') && !path.isAbsolute(rel); });
  if (!inside) return { error: `repo ${dir} is outside this session's working directory and added directories; add it with --add-dir first.` };
  return { dir };
}

export const agentTool = defineTool<AgentArgs>({
  name: 'agent',
  class: 'write',
  description: [
    'Delegate a self-contained coding task to a subagent. It can read, edit and run commands under this conversation\'s permissions.',
    'It sees the project instructions but not this conversation; include the task, files, constraints and expected result.',
    'By default it works in this working tree, its file edits belong to this turn\'s undo checkpoint, and it runs serially with other writes.',
    'With isolation "worktree" (git repositories only) it works in a fresh git worktree on a new branch from HEAD, without this tree\'s uncommitted changes; its result names the branch and summarizes the diff (a worktree with no changes is removed). Several isolated agent calls in one step run in parallel.',
    'When this session\'s working directory is not itself a git repository with a commit (a folder of repositories), pass `repo`: a directory inside the repository to work in. It implies isolation "worktree".',
    'With background true (implies isolation "worktree") the call returns an id at once and the agent works while you continue: agent_send gives it a follow-up instruction, agent_wait gets its result, and a result you did not wait for arrives as a message. This turn does not end while a background agent runs.',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'Complete coding task for the subagent.' },
      description: { type: 'string', description: 'Short label shown to the user.' },
      subagent_type: { type: 'string', description: 'An agent type listed under Agent types in the system prompt, when one fits. Omit for the general coding subagent.' },
      repo: { type: 'string', description: 'A directory inside the git repository the isolated or background agent works in, when the session\'s working directory is not one itself. Relative paths start from the working directory; it must be inside the session\'s directories.' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Run in its own git worktree and branch, so it can run in parallel with other agents.' },
      background: { type: 'boolean', description: 'Return an id at once and run in the background, in its own worktree.' },
    },
  },
  label: (args) => formatToolRow('agent', args.description?.trim() || args.prompt),
  paths: (args) => (args.repo ? [args.repo] : []),
  concurrent: (args) => args?.isolation === 'worktree' || args?.background === true || typeof args?.repo === 'string',
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'A subagent cannot start another subagent.', isError: true };
    const description = args.description?.trim();
    const type = resolveAgentType({ stateDir: ctx.stateDir, home: ctx.homeDir }, args.subagent_type);
    if ('error' in type) return { output: type.error, isError: true };
    const repo = resolveRepo(args.repo, ctx.cwd, ctx.addDirs);
    if (repo.error) return { output: repo.error, isError: true };
    const request = {
      prompt: args.prompt, kind: 'work' as const, ...type,
      ...(description ? { description } : {}),
      ...(args.isolation === 'worktree' || args.background || repo.dir ? { isolation: 'worktree' as const } : {}),
      ...(repo.dir ? { repo: repo.dir } : {}),
    };
    if (!args.background) return ctx.runSubagent(request);
    if (!ctx.agents) return { output: 'Background agents are not available here.', isError: true };
    // Refused now rather than as the agent's first and only result.
    if (!await canCreateAgentWorktree(repo.dir ?? ctx.cwd)) return { output: await noWorktreeMessage(repo.dir ?? ctx.cwd, repo.dir !== undefined), isError: true };
    const runSubagent = ctx.runSubagent;
    const id = ctx.agents.start(description || args.prompt.split('\n')[0].slice(0, 80), (onSteerReady) => runSubagent({ ...request, background: true, onSteerReady }));
    return {
      output: `Started ${id} in the background, in its own worktree. Carry on; agent_send("${id}", ...) gives it more instructions, agent_wait("${id}") gets its result.`,
      continuesAs: id,
    };
  },
});
