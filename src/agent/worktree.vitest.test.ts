import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { noWorktreeMessage } from './worktree.js';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'worktree-msg-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const repo = async (name: string, commit: boolean): Promise<void> => {
  const dir = path.join(root, name);
  await mkdir(dir);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  if (commit) git('commit', '-q', '--allow-empty', '-m', 'x');
};

it('names the repositories in a folder of repositories, only those with a commit', async () => {
  await repo('api', true);
  await repo('web', true);
  await repo('empty', false);
  await mkdir(path.join(root, 'notes'));
  const message = await noWorktreeMessage(root, false);
  expect(message).toMatch(/is not inside a git repository/);
  expect(message).toContain(`Repositories in ${root}: api, web;`);
  expect(message).not.toContain('empty');
});

it('suggests nothing when there is nothing to suggest', async () => {
  expect(await noWorktreeMessage(root, false)).not.toContain('Repositories in');
});
