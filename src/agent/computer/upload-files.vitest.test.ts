import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { downloadsDir } from './downloads.js';
import { approvedUploadPath, isUploadPath, MAX_UPLOAD_BYTES } from './upload-files.js';

let base = '';
let scope: { cwd: string; stateDir: string; homeDir: string; sessionId: string };
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'clikcode-upload-paths-')));
  scope = { cwd: join(base, 'work'), stateDir: join(base, 'state'), homeDir: join(base, 'home'), sessionId: 'chat-1' };
  await mkdir(scope.cwd, { recursive: true });
  await mkdir(join(scope.homeDir, '.ssh'), { recursive: true });
  await mkdir(downloadsDir(scope.stateDir, 'chat-1'), { recursive: true });
  await mkdir(downloadsDir(scope.stateDir, 'chat-2'), { recursive: true });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

it('tells a path from the name of a profile detail', () => {
  expect(isUploadPath('logo_file')).toBe(false);
  expect(isUploadPath('/tmp/a.png')).toBe(true);
  expect(isUploadPath('C:\\Users\\a\\x.png')).toBe(true);
  expect(isUploadPath('docs/a.png')).toBe(true);
});

it('allows a file in the workspace and one in this chat\'s downloads folder', async () => {
  const inWork = join(scope.cwd, 'logo.png');
  const inDownloads = join(downloadsDir(scope.stateDir, 'chat-1'), 'report.pdf');
  await writeFile(inWork, 'x'); await writeFile(inDownloads, 'y');
  expect(await approvedUploadPath(scope, inWork)).toBe(inWork);
  expect(await approvedUploadPath(scope, inDownloads)).toBe(inDownloads);
});

it('refuses another chat\'s download, files outside both folders, relative and missing paths', async () => {
  const other = join(downloadsDir(scope.stateDir, 'chat-2'), 'theirs.pdf');
  const outside = join(base, 'outside.txt');
  await writeFile(other, 'z'); await writeFile(outside, 'z');
  await expect(approvedUploadPath(scope, other)).rejects.toThrow(/outside the workspace/);
  await expect(approvedUploadPath(scope, outside)).rejects.toThrow(/outside the workspace/);
  await expect(approvedUploadPath(scope, 'logo.png')).rejects.toThrow(/absolute/);
  await expect(approvedUploadPath(scope, join(scope.cwd, 'nope.png'))).rejects.toThrow(/no such file/);
  await expect(approvedUploadPath(scope, scope.cwd)).rejects.toThrow(/not a file/);
});

it('refuses dotfiles and dot folders, even when the workspace is the home folder', async () => {
  await mkdir(join(scope.cwd, '.git'), { recursive: true });
  await writeFile(join(scope.cwd, '.env'), 'KEY=1');
  await writeFile(join(scope.cwd, '.git', 'config'), 'x');
  await writeFile(join(scope.homeDir, '.ssh', 'id_ed25519'), 'k');
  await writeFile(join(scope.homeDir, '.bashrc'), 'k');
  await expect(approvedUploadPath(scope, join(scope.cwd, '.env'))).rejects.toThrow(/hidden/);
  await expect(approvedUploadPath(scope, join(scope.cwd, '.git', 'config'))).rejects.toThrow(/hidden/);
  const home = { ...scope, cwd: scope.homeDir };
  await expect(approvedUploadPath(home, join(scope.homeDir, '.ssh', 'id_ed25519'))).rejects.toThrow(/hidden/);
  await expect(approvedUploadPath(home, join(scope.homeDir, '.bashrc'))).rejects.toThrow(/hidden/);
});

it('refuses ClikCode\'s own state, private keys and credential files', async () => {
  const inState = { ...scope, cwd: scope.stateDir };
  await writeFile(join(scope.stateDir, 'secret.txt'), 's');
  await expect(approvedUploadPath(inState, join(scope.stateDir, 'secret.txt'))).rejects.toThrow(/private to ClikCode/);
  for (const name of ['id_rsa', 'server.pem', 'tls.key', 'credentials', 'client-secrets.json']) {
    await writeFile(join(scope.cwd, name), 'k');
    await expect(approvedUploadPath(scope, join(scope.cwd, name))).rejects.toThrow(/key or credentials/);
  }
});

it('refuses a symlink in the workspace that points outside it', async () => {
  const target = join(base, 'private.txt');
  await writeFile(target, 'p');
  try { await symlink(target, join(scope.cwd, 'innocent.txt')); } catch { return; } // no symlinks (Windows without privilege)
  await expect(approvedUploadPath(scope, join(scope.cwd, 'innocent.txt'))).rejects.toThrow(/outside the workspace/);
  await symlink(join(scope.homeDir, '.ssh'), join(scope.cwd, 'dir-link'));
  await writeFile(join(scope.homeDir, '.ssh', 'known_hosts'), 'h');
  await expect(approvedUploadPath(scope, join(scope.cwd, 'dir-link', 'known_hosts'))).rejects.toThrow(/outside the workspace/);
});

it('refuses a file over the size limit', async () => {
  const big = join(scope.cwd, 'big.bin');
  await writeFile(big, '');
  const { truncate } = await import('node:fs/promises');
  await truncate(big, MAX_UPLOAD_BYTES + 1);
  await expect(approvedUploadPath(scope, big)).rejects.toThrow(/limit/);
});
