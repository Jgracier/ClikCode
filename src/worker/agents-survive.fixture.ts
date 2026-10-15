/** A real git repository and agent worktree for the survival check. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentWorktree, type AgentWorktree } from '../agent/worktree.js';

const run = promisify(execFile);

export async function createWorktreeForTest(dir: string): Promise<AgentWorktree> {
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const git = (...args: string[]) => run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo });
  await git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), 'base\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  const worktree = await createAgentWorktree(repo, 'survive');
  if (!worktree) throw new Error('no worktree');
  return worktree;
}
