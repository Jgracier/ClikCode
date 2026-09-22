/** Where each vendor keeps a conversation on disk, as one table.
 *
 * This is the third of the per-vendor registries in this directory, beside
 * FS_SESSION_DISCOVERY and ADOPTED_TRANSCRIPT_READERS, and it exists for the
 * same reason they do: a vendor's on-disk layout is a real, unrelated shape
 * with nothing left to normalise, so it belongs in a table with one entry per
 * vendor rather than in a declarative catalog field.
 *
 * It replaces a pair of `if (harness.command === ...)` chains in locations.ts
 * that had to be edited in TWO places to add a harness -- which is exactly the
 * shape that stops at two vendors and never grows.
 *
 * What a store is for: every ClikCode account runs its harness against a
 * redirected home, so the same conversation id resolves to a different file
 * per account. Knowing the file lets an account failover CARRY the vendor's
 * own thread across, so the new account resumes what was actually said instead
 * of being re-seeded with a retelling of it.
 *
 * A harness with no entry is not broken: it falls back to re-seeding, exactly
 * as every harness did before any of this existed. An entry is an optimisation,
 * and a wrong one is worse than none -- so only layouts directly observed on
 * disk are listed here, never inferred from a vendor's docs.
 */

export type NativeSessionEnvironment = Readonly<Record<string, string>>;

/** `root` is the directory the per-session path is relative to, so a caller
 *  can rebuild the same relative path under another profile without knowing
 *  anything about how the vendor lays its files out. */
export type NativeSessionFile = { path: string; root: string };

/** Everything a vendor-specific carry needs to move one conversation. */
export type NativeSessionCarry = {
  nativeId: string;
  workspace: string;
  /** The environment the conversation was written under. */
  from: NativeSessionEnvironment;
  /** The environment it has to be readable under. */
  to: NativeSessionEnvironment;
};

/** A store describes a conversation one of two ways, and implements the
 *  matching member:
 *
 *  - `locate` -- the conversation IS a path (a transcript, or a directory of
 *    them). Almost every vendor. Carrying is then a copy the caller performs,
 *    and the same path is also what a title read opens.
 *  - `carry` -- the conversation is not separable as a path, so only the
 *    vendor's own store knows how to move it. Hermes is the one so far: every
 *    conversation lives as rows in one shared SQLite database that also holds
 *    the account's other sessions, so copying the file would overwrite them.
 *
 *  `root` is required either way: it is what tells two accounts apart, and a
 *  shared root already means the conversation never moved. */
export interface NativeSessionStore {
  /** The directory this vendor keeps conversations under, for a given
   *  environment, or undefined when that environment cannot place it. */
  root(environment: NativeSessionEnvironment): string | undefined;
  /** The file holding one conversation, or undefined when it is not there. */
  locate?(
    root: string, nativeId: string, workspace: string, environment: NativeSessionEnvironment,
  ): Promise<NativeSessionFile | undefined>;
  /** Move one conversation into `to`, returning whether it is now readable
   *  there. Must never fail destructively: the caller's fallback is to
   *  re-seed, which is always available, so anything uncertain returns false
   *  and leaves both stores as they were. */
  carry?(input: NativeSessionCarry): Promise<boolean>;
}

export function nativeDataRoot(
  environment: NativeSessionEnvironment, variable: string, fallback: string,
): string {
  return environment[variable]?.trim() || fallback;
}

// The table itself lives in registry.ts, beside the other two per-vendor
// registries. It was briefly a mutable object here, filled by a side effect
// on import -- which meant any module reaching locations.ts without having
// loaded registry.ts first would silently see NO stores and fall back to
// re-seeding. carry.ts imports exactly that way, so the hazard was real.
