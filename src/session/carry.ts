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
import { locateNativeSessionFile, nativeSessionRoot, type NativeSessionEnvironment } from './discovery/locations.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';

type CarryNativeSessionInput = {
  harness: AiLocalHarnessDefinition;
  nativeId: string | undefined;
  workspace: string | undefined;
  /** The environment the session was written under -- the losing account's. */
  from: NativeSessionEnvironment;
  /** The environment it has to exist under -- the account taking over. */
  to: NativeSessionEnvironment;
};

/** Whether the taking-over account can reach the vendor thread, and why.
 *
 * Three outcomes, and they are NOT interchangeable -- conflating two of them
 * is what made every non-Claude/Codex failover re-send the whole
 * conversation:
 *
 *   'carried'  the file was copied into the new profile; resume works.
 *   'present'  nothing to do, because the thread never moved. Both accounts
 *              run this harness against the SAME vendor profile, so the file
 *              the old account wrote is the file the new one will read.
 *   undefined  genuinely out of reach: the profiles differ AND this vendor's
 *              on-disk layout is unknown, so the thread is stranded in the
 *              losing account's home.
 *
 * Only the third is a reason to re-seed. 'present' used to return undefined
 * too -- with a comment saying "the session is where it needs to be" -- and
 * the caller then threw the thread id away and rehydrated anyway. */
export type CarryOutcome = 'carried' | 'present' | undefined;
/** Do both accounts run this harness against the same vendor home?
 *
 * A harness with no profileEnv has one home for every account by definition.
 * One that has a profileEnv shares it whenever the two environments point at
 * the same path -- which happens when neither account has an isolated profile
 * yet. */
function sharesVendorProfile(
  harness: AiLocalHarnessDefinition, from: NativeSessionEnvironment, to: NativeSessionEnvironment,
): boolean {
  const key = harness.profileEnv;
  const read = (env: NativeSessionEnvironment, name: string): string | undefined =>
    (env as Record<string, string | undefined>)[name];
  // Declared isolation: the one variable that moves the vendor's home decides
  // it, whatever else differs between the two environments.
  if (key) return read(from, key) === read(to, key);
  // No declared isolation. Rather than assume, compare what the harness will
  // actually run under: any home-shaped variable that differs means the two
  // accounts do NOT share a vendor home, even though nothing declared it.
  // Equal environments are the same home by definition.
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const name of names) {
    if (!/HOME$|_DIR$|_CONFIG/i.test(name)) continue;
    if (read(from, name) !== read(to, name)) return false;
  }
  return true;
}

export async function carryNativeSession(input: CarryNativeSessionInput): Promise<CarryOutcome> {
  const { harness, nativeId, workspace } = input;
  if (!nativeId) return undefined;
  // Asked FIRST, and without any knowledge of where this vendor keeps its
  // threads, because when the profile is shared the answer does not depend on
  // that: the losing account and the one taking over run the harness against
  // the same home, so the thread is already exactly where it will be looked
  // for. Fifteen of the twenty-four harnesses declare no profileEnv at all
  // and are therefore always in this case -- they were re-seeding the entire
  // conversation to reach a file that had never moved.
  if (sharesVendorProfile(harness, input.from, input.to)) return 'present';
  if (!workspace) return undefined;
  const target = nativeSessionRoot(harness, input.to);
  if (!target) return undefined;
  if (target === nativeSessionRoot(harness, input.from)) return 'present';
  const source = await locateNativeSessionFile(harness, nativeId, workspace, input.from);
  if (!source) return undefined;
  const destination = join(target, relative(source.root, source.path));
  try {
    // A conversation that went A -> B -> A finds its own earlier copy waiting
    // in A, one switch out of date: everything the thread said while B owned
    // it is only in B's file. Returning the copy as-is would resume the older
    // transcript and silently drop that work. A vendor transcript is an
    // append-only log, so the newer, longer file is the current one, and it
    // replaces what is there; an identical one is left alone.
    const [here, there] = await Promise.all([
      stat(destination).catch(() => undefined),
      stat(source.path).catch(() => undefined),
    ]);
    if (!there) return undefined;
    if (here && here.size >= there.size && here.mtimeMs >= there.mtimeMs) return 'carried';
    await mkdir(dirname(destination), { recursive: true });
    // Through a temporary name in the destination directory: a half-copied
    // transcript that a resume then read would be worse than no transcript.
    const staged = `${destination}.clikcode-carry`;
    await copyFile(source.path, staged);
    // rename() replaces an existing destination atomically, so a resume can
    // never read a file that is half one transcript and half the other.
    await rename(staged, destination);
    return 'carried';
  } catch {
    // fail-open-ok: carrying is an optimization over re-seeding, never a requirement.
    return undefined;
  }
}
