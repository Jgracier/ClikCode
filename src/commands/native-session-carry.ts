/** Carrying a vendor's own session from one account's profile to another's.
 *
 * Every ClikCode account runs its harness with a redirected home, and a vendor
 * writes its session transcript inside that home -- Claude Code under
 * `projects/<workspace>/<id>.jsonl`, Codex under `sessions/<y>/<m>/<d>/…`. So
 * the thread belongs to the account, not to the conversation: launch the CLI
 * against another account and `--resume <id>` finds nothing, because the file
 * is in the first account's profile.
 *
 * That is the only reason a quota failover used to start a fresh thread and
 * re-seed it from ClikCode's own copy of the conversation -- which works, but
 * hands the model a truncated retelling instead of what it actually said, and
 * makes it re-read a workspace it had just finished reading. Copying the one
 * file across and resuming it is all the vendor needs to carry on.
 *
 * Copy, never move: the losing account's history stays its own, and a failed
 * copy simply leaves the caller to fall back to re-seeding.
 */

import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  locateNativeSessionFile, nativeSessionRoot, type NativeSessionEnvironment,
} from './native-session-discovery.js';
import type { AiLocalHarnessDefinition } from './types.js';

export type CarryNativeSessionInput = {
  harness: AiLocalHarnessDefinition;
  nativeId: string | undefined;
  workspace: string | undefined;
  /** The environment the session was written under -- the losing account's. */
  from: NativeSessionEnvironment;
  /** The environment it has to exist under -- the account taking over. */
  to: NativeSessionEnvironment;
};

/** The path the session now also lives at, or undefined when it could not be
 * carried: an unsupported harness, a file that is not there, a profile that
 * cannot be written to. Undefined is not a failure to report -- it is the
 * caller's signal to re-seed a fresh thread the way it always did. */
export async function carryNativeSession(input: CarryNativeSessionInput): Promise<string | undefined> {
  const { harness, nativeId, workspace } = input;
  if (!nativeId || !workspace) return undefined;
  const target = nativeSessionRoot(harness, input.to);
  if (!target) return undefined;
  // Both profiles already resolve to the same directory (one account, or none
  // redirecting): the session is where it needs to be.
  if (target === nativeSessionRoot(harness, input.from)) return undefined;
  const source = await locateNativeSessionFile(harness, nativeId, workspace, input.from);
  if (!source) return undefined;
  const destination = join(target, relative(source.root, source.path));
  try {
    if (await stat(destination).then(() => true, () => false)) return destination;
    await mkdir(dirname(destination), { recursive: true });
    // Through a temporary name in the destination directory: a half-copied
    // transcript that a resume then read would be worse than no transcript.
    const staged = `${destination}.clikcode-carry`;
    await copyFile(source.path, staged);
    await rename(staged, destination);
    return destination;
  } catch {
    // fail-open-ok: carrying is an optimization over re-seeding, never a requirement.
    return undefined;
  }
}
