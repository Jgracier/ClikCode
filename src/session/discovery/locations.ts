/** Where each vendor keeps its sessions, and how to find one file again. */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition } from '../../harness/types.js';
import { claudeProjectDirectoryNames } from './vendors/claude.js';
import { locateCodexRollout } from './vendors/codex.js';

/** Claude Code has no CLI command that lists past sessions (`--resume` with no
 * id opens an interactive TUI picker only), but it writes one real, stable
 * `<uuid>.jsonl` file per session under a project folder named after the cwd
 * (see claudeProjectDirectoryNames) — directly observed on disk, not guessed. The
 * first line is often `{"type":"ai-title","aiTitle":"..."}`; older sessions
 * without one fall back to the first `type":"user"` message's own text. */
export type NativeSessionEnvironment = Readonly<Record<string, string>>;

export function nativeDataRoot(environment: NativeSessionEnvironment, variable: string, fallback: string): string {
  return environment[variable]?.trim() || fallback;
}

/** Where a vendor keeps its session transcripts, and which file is this
 * session's, under a GIVEN environment rather than this process's own.
 *
 * The environment is what makes it useful: every ClikCode account runs its
 * harness with a redirected home, so the same session id resolves to a
 * different file per account. Reading is one use; carrying a session from one
 * account's profile to another's -- which is what lets a quota failover resume
 * the vendor's own thread instead of re-seeding a fresh one -- is the other.
 *
 * `root` is the directory the per-session path is relative to, so a caller can
 * rebuild the same relative path under another profile without knowing
 * anything about how a vendor lays its files out. */
export type NativeSessionFile = { path: string; root: string };

export function nativeSessionRoot(
  harness: AiLocalHarnessDefinition, environment: NativeSessionEnvironment = {},
): string | undefined {
  if (harness.command === 'claude') return join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects');
  if (harness.command === 'codex') return join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  return undefined;
}

export async function locateNativeSessionFile(
  harness: AiLocalHarnessDefinition, nativeId: string, workspace: string,
  environment: NativeSessionEnvironment = {},
): Promise<NativeSessionFile | undefined> {
  const root = nativeSessionRoot(harness, environment);
  if (!root || !nativeId) return undefined;
  if (harness.command === 'claude') {
    for (const name of claudeProjectDirectoryNames(workspace)) {
      const path = join(root, name, `${nativeId}.jsonl`);
      if (await stat(path).then(() => true, () => false)) return { path, root };
    }
    return undefined;
  }
  const path = await locateCodexRollout(root, nativeId);
  return path ? { path, root } : undefined;
}
