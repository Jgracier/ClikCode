/** The directories a session may read and write, and what changed in them. */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { spawnPortable as spawn } from '../../harness/transport/spawn.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactPath } from '../../harness/protocol/labels.js';
import { writeState } from '../../session/state/write.js';
import { closePersistentTransport } from '../../turn/runtime.js';
import { decodeAttachmentPath, expandHomePath } from '../../session/attachments.js';
import { optionForControl } from '../../session/options.js';
import { sessionHarness } from './context.js';

function captureProcess(command: string, args: readonly string[], cwd?: string, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    if (stdinText !== undefined) child.stdin!.end(stdinText);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}

/** Everything that differs from the last commit: staged and unstaged changes
 * against HEAD, plus files git does not track yet (which `git diff` never shows). */
export async function workspaceDiff(workspace: string): Promise<string> {
  const git = (args: readonly string[]): Promise<string> => captureProcess('git', args, workspace);
  const hasHead = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  // A repository with no commit yet has no HEAD: everything staged is the change.
  const base = hasHead ? ['diff', '--no-ext-diff', 'HEAD'] : ['diff', '--no-ext-diff', '--cached'];
  const [stat, details, untracked] = await Promise.all([
    git([...base, '--stat', '--', '.']), git([...base, '--', '.']),
    git(['ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => ''),
  ]);
  const untrackedFiles = untracked.split(/\r?\n/).filter(Boolean);
  const sections = [
    stat.trim(), details.trim(),
    untrackedFiles.length ? `Untracked files (${untrackedFiles.length}):\n${untrackedFiles.slice(0, 200).map((file) => `  ${file}`).join('\n')}${untrackedFiles.length > 200 ? `\n  … ${untrackedFiles.length - 200} more` : ''}` : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 512 * 1024);
}

async function resolveExistingDirectory(session: HarnessSession, raw: string): Promise<string> {
  const expanded = expandHomePath(decodeAttachmentPath(raw));
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(session.workspace ?? process.cwd(), expanded);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${compactPath(path)} does not exist.`);
  if (!info.isDirectory()) throw new Error(`${compactPath(path)} is not a directory.`);
  return path;
}

/** A native session belongs to the directory it was started in, so moving the
 * conversation drops it (the transcript is replayed into the next one) and
 * closes any live transport child, whose cwd is fixed at spawn. */
export async function changeSessionWorkspace(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  const path = await resolveExistingDirectory(session, raw);
  if (path === (session.workspace ?? process.cwd())) return `Already working in ${compactPath(path)}.`;
  const droppedNative = Boolean(session.nativeSessionId);
  session.workspace = path;
  session.nativeSessionId = undefined;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  await closePersistentTransport(session.id);
  return `Working directory is now ${compactPath(path)}.${droppedNative ? ' The native session belonged to the previous directory, so the next turn starts a fresh one with this conversation replayed.' : ''}`;
}

/** Stored as the harness's own declared `add-dir` option, so every transport
 * renders it the way the catalog says. No declaration, no pretending. */
export async function addSessionDirectory(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  if (!raw.trim()) throw new Error('usage: /add-dir <dir>');
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider before adding directories.');
  const option = optionForControl(harness, '/add-dir');
  if (!option) throw new Error(`${harness.displayName} does not declare an additional-directory option; start ClikCode from a common parent directory or use /cwd instead.`);
  const path = await resolveExistingDirectory(session, raw);
  const current = session.harnessOptions?.[option.id];
  const existing = Array.isArray(current) ? current.map(String) : typeof current === 'string' && current ? [current] : [];
  if (existing.includes(path)) return `${compactPath(path)} is already available to ${harness.displayName}.`;
  session.harnessOptions = { ...session.harnessOptions, [option.id]: option.kind === 'path-list' || option.kind === 'string-list' ? [...existing, path] : path };
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // A live ACP child took its option argv at spawn.
  await closePersistentTransport(session.id);
  return `${harness.displayName} can now also work in ${compactPath(path)}.`;
}
