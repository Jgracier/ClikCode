/** Where each vendor keeps its sessions, and how to find one file again. */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { nativeSessionStore } from './registry.js';
import type { NativeSessionEnvironment, NativeSessionFile } from './stores.js';

/** Claude Code has no CLI command that lists past sessions (`--resume` with no
 * id opens an interactive TUI picker only), but it writes one real, stable
 * `<uuid>.jsonl` file per session under a project folder named after the cwd
 * (see claudeProjectDirectoryNames) — directly observed on disk, not guessed. The
 * first line is often `{"type":"ai-title","aiTitle":"..."}`; older sessions
 * without one fall back to the first `type":"user"` message's own text. */
export type { NativeSessionEnvironment, NativeSessionFile } from './stores.js';
export { nativeDataRoot } from './stores.js';


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

export function nativeSessionRoot(
  harness: AiLocalHarnessDefinition, environment: NativeSessionEnvironment = {},
): string | undefined {
  return nativeSessionStore(harness)?.root(environment);
}

export async function locateNativeSessionFile(
  harness: AiLocalHarnessDefinition, nativeId: string, workspace: string,
  environment: NativeSessionEnvironment = {},
): Promise<NativeSessionFile | undefined> {
  const store = nativeSessionStore(harness);
  const root = store?.root(environment);
  // A store that carries its own conversations (see NativeSessionStore) has no
  // per-conversation path to hand back, and that is not a failure: callers
  // already treat undefined as "not reachable as a file".
  if (!store?.locate || !root || !nativeId) return undefined;
  return store.locate(root, nativeId, workspace, environment);
}
