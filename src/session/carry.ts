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
 *
 * What gets copied is an ARTIFACT, not strictly a file: most vendors keep a
 * conversation in one transcript, but Copilot keeps a directory -- the
 * transcript plus the workspace.yaml that names the id and cwd it resumes
 * against. Both shapes carry the same way here, so a vendor that splits its
 * conversation across a few files needs a store entry and nothing more.
 */

import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { locateNativeSessionFile, nativeSessionRoot, type NativeSessionEnvironment } from './discovery/locations.js';
import { nativeSessionStore } from './discovery/registry.js';
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
  // A vendor whose conversation is not separable as a path carries it itself
  // -- Hermes keeps every conversation as rows in one shared database. See
  // NativeSessionStore.
  const store = nativeSessionStore(harness);
  if (store?.carry) {
    const carried = await store.carry({ nativeId, workspace, from: input.from, to: input.to })
      .catch(() => false);
    return carried ? 'carried' : undefined;
  }
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
    const [here, there] = await Promise.all([measure(destination), measure(source.path)]);
    if (!there) return undefined;
    if (here && here.size >= there.size && here.mtime >= there.mtime) return 'carried';
    await mkdir(dirname(destination), { recursive: true });
    // Through a temporary name in the destination directory: a half-copied
    // transcript that a resume then read would be worse than no transcript.
    const staged = `${destination}.clikcode-carry`;
    await rm(staged, { recursive: true, force: true });
    await cp(source.path, staged, { recursive: true });
    // rename() replaces an existing destination atomically -- but only a file
    // over a file. A non-empty directory refuses to be renamed over, so the
    // one already there moves aside first and is deleted only once the new one
    // is in place; a crash in between leaves the old copy recoverable rather
    // than leaving no copy at all.
    if (here?.directory) {
      const displaced = `${destination}.clikcode-old`;
      await rm(displaced, { recursive: true, force: true });
      await rename(destination, displaced);
      await rename(staged, destination);
      await rm(displaced, { recursive: true, force: true });
    } else {
      await rename(staged, destination);
    }
    return 'carried';
  } catch {
    // fail-open-ok: carrying is an optimization over re-seeding, never a requirement.
    return undefined;
  }
}

/** Size and recency of an artifact, whether it is one transcript or a tree of
 *  them, so the "newer and longer wins" rule above reads the same for both.
 *
 *  A vendor transcript is append-only, so total bytes across the tree only
 *  grows as a conversation does, and the newest mtime in it is when the thread
 *  last spoke. Comparing the aggregate is therefore the same comparison a
 *  single file gets, not an approximation of it. */
async function measure(
  path: string,
): Promise<{ size: number; mtime: number; directory: boolean } | undefined> {
  const entry = await stat(path).catch(() => undefined);
  if (!entry) return undefined;
  if (!entry.isDirectory()) return { size: entry.size, mtime: entry.mtimeMs, directory: false };
  let size = 0;
  let mtime = entry.mtimeMs;
  for (const child of await readdir(path, { withFileTypes: true })) {
    const inner = await measure(join(path, child.name));
    if (!inner) continue;
    size += inner.size;
    mtime = Math.max(mtime, inner.mtime);
  }
  return { size, mtime, directory: true };
}
