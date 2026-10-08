/** Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<cwd-as-name>/<id>.jsonl`
 * plus `<id>/subagents` and `<id>/tool-results` when that turn used them.
 *
 * Project-scoped, so the same id under a different workspace is a different
 * file -- which is why locate() takes the workspace and tries every name the
 * cwd can produce (see claudeProjectDirectoryNames). Moved here verbatim from
 * an if-chain in locations.ts; the behaviour is unchanged. */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { CanonicalRecord } from '../../canonical.js';
import {
  nativeDataRoot,
  type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriteContext,
  type NativeThreadWriter, type NativeThreadWritten,
} from '../stores.js';
import { claudeProjectDirectoryNames } from './claude.js';
import { testedVersion, versionNumber } from './thread-writer-files.js';
import { claudeProjectDirectoryName, claudeThreadJsonl } from './claude-thread.js';
import { placeArtifact } from '../../carry-artifact.js';

const CLAUDE_TESTED_VERSIONS = ['2.1.288'] as const;

/** The account's config dir: its CLAUDE_CONFIG_DIR, else the `.claude` of the
 *  HOME it runs under -- never this process's own unless that is the one. */
function claudeConfigDir(environment: NativeSessionEnvironment): string {
  return nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(environment.HOME?.trim() || homedir(), '.claude'));
}

/** A new parent session file, staged under a temporary name and renamed into
 * place. Claude Code keeps no index; its own turns may later create a sibling
 * directory for subagent transcripts and tool results. */
async function writeClaudeThread(record: CanonicalRecord, context: NativeThreadWriteContext): Promise<NativeThreadWritten | undefined> {
  const sessionId = randomUUID();
  const directory = join(claudeConfigDir(context.environment), 'projects', claudeProjectDirectoryName(context.workspace));
  const path = join(directory, `${sessionId}.jsonl`);
  const staged = `${path}.clikcode-write`;
  const text = claudeThreadJsonl(record, {
    sessionId, cwd: context.workspace,
    model: context.model && /^claude-/.test(context.model) ? context.model : null,
    version: versionNumber(context.version) ?? CLAUDE_TESTED_VERSIONS[0],
  });
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(staged, text, { flag: 'wx', mode: 0o600 });
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
  return { nativeId: sessionId };
}

export const claudeThreadWriter: NativeThreadWriter = {
  testedVersions: CLAUDE_TESTED_VERSIONS,
  versionOk: (context) => testedVersion(CLAUDE_TESTED_VERSIONS)(context),
  write: writeClaudeThread,
};

export const claudeSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects');
  },
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    for (const name of claudeProjectDirectoryNames(workspace)) {
      const path = join(root, name, `${nativeId}.jsonl`);
      if (await stat(path).then(() => true, () => false)) return { path, root };
    }
    return undefined;
  },
  async carry({ nativeId, workspace, from, to }): Promise<boolean> {
    // Claude keeps subagent transcripts and tool results beside the main
    // JSONL, under a directory named after the session. The parent file
    // alone resumes, but loses the work its child agents had already done.
    const sourceRoot = join(claudeConfigDir(from), 'projects');
    const source = await claudeSessionStore.locate!(sourceRoot, nativeId, workspace, from);
    if (!source) return false;
    const targetRoot = join(claudeConfigDir(to), 'projects');
    const target = join(targetRoot, relative(sourceRoot, source.path));
    const sourceChildren = source.path.slice(0, -'.jsonl'.length);
    const targetChildren = target.slice(0, -'.jsonl'.length);
    // Stage the children first. If that copy fails, do not publish a parent
    // transcript which appears resumable while its child artifacts are absent.
    if (await stat(sourceChildren).then((entry) => entry.isDirectory(), () => false)) {
      if (!await placeArtifact(sourceChildren, targetChildren)) return false;
    }
    return placeArtifact(source.path, target);
  },
  writer: claudeThreadWriter,
};
