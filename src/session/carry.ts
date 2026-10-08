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

import { join, relative } from 'node:path';
import { placeArtifact } from './carry-artifact.js';
import { locateNativeSessionFile, nativeSessionRoot, nativeSessionStore, type NativeSessionEnvironment } from './discovery/registry.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { turnEnvironment } from '../turn/turn-environment.js';
import type { HarnessSession } from './model.js';
import { forgetNativeThread } from './native-thread.js';

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

/** A conversation moving to another account takes its vendor thread along;
 * one that cannot be carried (or no harness or previous account to carry it
 * from) is forgotten, so the next turn takes the conversation up afresh.
 * The one step for a pre-turn move, a failover and `/accounts use`.
 *
 * An id ClikCode minted that the vendor never confirmed is no thread at all:
 * calling it 'present' sent the next account only "carry on", and the
 * request it was never shown was lost. */
export async function moveThreadToAccount(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined,
  from: AiHarnessAccount | undefined, to: AiHarnessAccount,
): Promise<CarryOutcome> {
  const carried = harness && from ? await carryNativeSession({
    harness, nativeId: session.nativeSessionPreallocated ? undefined : session.nativeSessionId, workspace: session.workspace,
    from: turnEnvironment(harness, from), to: turnEnvironment(harness, to),
  }).catch(() => undefined) : undefined;
  if (carried) session.nativeThreadAccountId = to.id;
  else forgetNativeThread(session);
  return carried;
}

/** Whether a thread has to be carried before it can be resumed: the
 * conversation has a confirmed vendor thread. An id ClikCode minted that the
 * vendor never confirmed is no thread at all. */
const hasVendorThread = (session: HarnessSession): boolean =>
  Boolean(session.nativeSessionId) && !session.nativeSessionPreallocated;

/** The one guarantee that makes "it should not matter which account": before
 * a turn runs under `to`, the conversation's vendor thread is in `to`'s
 * profile. Whoever changed `accountId` -- the account picker, a command, a
 * failover, an older build, another process -- the next turn comes here, so
 * there is no switch that can leave the two apart and no deferred note to be
 * lost between processes.
 *
 * Carrying is safe to repeat: a copy the destination already has, or a newer
 * one, is left alone (carry-artifact.ts, sqlite-carry.ts), so an account that
 * holds an older copy is brought up to date and never the other way round.
 *
 * The holder is `nativeThreadAccountId`. A conversation from before it was
 * kept has none; its thread is looked for in the other accounts of the
 * provider, once, and the answer is kept.
 *
 * 'present' -- already readable under `to`; 'carried' -- moved there;
 * 'forgotten' -- no account has it (the vendor deleted it, or this vendor's
 * layout is not known), so the next turn takes the conversation up afresh
 * from ClikCode's record; 'none' -- nothing to reconcile. */
export async function reconcileNativeThread(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined,
  accounts: readonly AiHarnessAccount[], to: AiHarnessAccount,
): Promise<'present' | 'carried' | 'forgotten' | 'none'> {
  if (!harness || !hasVendorThread(session)) return 'none';
  if (session.nativeThreadAccountId === to.id) return 'present';
  const holder = session.nativeThreadAccountId ? accounts.find((item) => item.id === session.nativeThreadAccountId) : undefined;
  const sources = holder ? [holder] : accounts.filter((item) => item.id !== to.id && item.provider === to.provider && item.authKind === 'vendor-cli');
  for (const from of sources) {
    const carried = await carryNativeSession({
      harness, nativeId: session.nativeSessionId, workspace: session.workspace,
      from: turnEnvironment(harness, from), to: turnEnvironment(harness, to),
    }).catch(() => undefined);
    if (carried) {
      session.nativeThreadAccountId = to.id;
      return carried;
    }
  }
  // Nothing carried. A holder that was named and could not give it up is the
  // end of this thread. With no holder on record, `to` may simply have it
  // already -- the conversation never left it -- and where the vendor's layout
  // can say so, it does.
  if (!holder) {
    const here = await locateNativeSessionFile(harness, session.nativeSessionId!, session.workspace ?? '', turnEnvironment(harness, to)).catch(() => undefined);
    // A vendor that keeps conversations as database rows cannot be asked
    // whether `to` has it: assume so, as every turn before this did, and keep
    // the answer so the other accounts are not searched on every turn.
    if (here || !nativeSessionStore(harness)?.locate) {
      session.nativeThreadAccountId = to.id;
      return 'present';
    }
  }
  forgetNativeThread(session);
  return 'forgotten';
}

export async function carryNativeSession(input: CarryNativeSessionInput): Promise<CarryOutcome> {
  const { harness, nativeId, workspace } = input;
  if (!nativeId) return undefined;
  // Asked FIRST, and without any knowledge of where this vendor keeps its
  // threads, because when the profile is shared the answer does not depend on
  // that: the losing account and the one taking over run the harness against
  // the same home, so the thread is already exactly where it will be looked
  // for. Accounts intentionally sharing a vendor profile are always in this
  // case; isolated profiles need a known transcript store to carry.
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
    if (!await placeArtifact(source.path, destination)) return undefined;
    // The vendor's own index has to agree with the copy (NativeSessionStore
    // reconcile): Codex trusts a row over the file.
    return !store?.reconcile || await store.reconcile({ nativeId, path: destination, environment: input.to }).catch(() => false)
      ? 'carried' : undefined;
  } catch {
    // fail-open-ok: carrying is an optimization over re-seeding, never a requirement.
    return undefined;
  }
}
