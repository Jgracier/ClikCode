/** A coding subagent's own git worktree: a fresh checkout of HEAD on a new
 * branch, so several agents can edit at once without touching each other or
 * the user's working tree.
 *
 * It lives in a unique directory under the system temp dir (writes inside
 * .git are refused to the agent) and only while the agent runs: on finish
 * its work is committed to its branch, the checkout is removed, and the
 * branch stays only if it holds a change. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface AgentWorktree {
  /** The checkout's root. */
  root: string;
  /** Where the agent works: the same subdirectory of the checkout as the parent's cwd. */
  cwd: string;
  branch: string;
  /** The commit the branch started from. */
  base: string;
  /** The repository's own work tree, where git runs once the checkout is gone. */
  repo: string;
}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], {
      cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve(String(stdout));
    });
  });
}

/** Undefined when cwd is not inside a git work tree with at least one commit. */
export async function createAgentWorktree(cwd: string, label = 'agent'): Promise<AgentWorktree | undefined> {
  let top: string;
  let base: string;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    base = (await git(['rev-parse', '--verify', 'HEAD^{commit}'], cwd)).trim();
  } catch {
    return undefined;
  }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent';
  const name = `${slug}-${randomUUID().slice(0, 8)}`;
  const branch = `clikcode/${name}`;
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-agent-'));
  const root = path.join(holder, path.basename(top) || 'repo');
  try {
    await git(['worktree', 'add', '-q', '-b', branch, root, base], top);
  } catch (error) {
    await fs.rm(holder, { recursive: true, force: true });
    throw error;
  }
  const relative = path.relative(await fs.realpath(top), await fs.realpath(path.resolve(cwd)));
  // An untracked subdirectory is not in the checkout; the agent still starts there.
  const agentCwd = path.join(root, relative);
  await fs.mkdir(agentCwd, { recursive: true });
  return { root, cwd: agentCwd, branch, base, repo: top };
}

/** Commits what the agent left uncommitted onto its branch, removes the
 * checkout, and says where the work is. A branch with no change goes too. */
export async function finishAgentWorktree(worktree: AgentWorktree, message: string): Promise<string> {
  const { root, branch, base } = worktree;
  try {
    if ((await git(['status', '--porcelain'], root)).trim()) {
      await git(['add', '-A'], root);
      // A scratch branch: the repository's hooks are for the user's own commits.
      await git(['commit', '--no-verify', '-q', '-m', message], root).catch(async () => {
        // No identity configured: still a commit, clearly the agent's.
        await git(['-c', 'user.name=ClikCode agent', '-c', 'user.email=agent@clikcode.invalid', 'commit', '--no-verify', '-q', '-m', message], root);
      });
    }
    const commits = (await git(['log', '--oneline', `${base}..HEAD`], root)).trim();
    const stat = commits ? (await git(['diff', '--stat', `${base}..HEAD`], root)).trim() : '';
    await removeAgentWorktree(worktree, !commits);
    if (!commits) return '[Worktree: no changes were made; its worktree and branch were removed.]';
    const short = base.slice(0, 12);
    return [
      `[Worktree: the changes are on branch ${branch} (from ${short}), not in this working tree.`,
      `Commits:\n${commits}`,
      `Diff summary:\n${stat}`,
      `Review with \`git diff ${short}..${branch}\`; bring them in with \`git merge ${branch}\` or cherry-pick; discard with \`git branch -D ${branch}\`.]`,
    ].join('\n');
  } catch (error) {
    return `[Worktree ${root} on branch ${branch} was left as is: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

export async function removeAgentWorktree(worktree: AgentWorktree, deleteBranch: boolean): Promise<void> {
  await git(['worktree', 'remove', '--force', worktree.root], worktree.repo);
  await fs.rm(path.dirname(worktree.root), { recursive: true, force: true });
  if (deleteBranch) await git(['branch', '-D', worktree.branch], worktree.repo);
}
