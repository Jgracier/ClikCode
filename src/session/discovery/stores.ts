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

import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { CanonicalRecord } from '../canonical.js';

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
  /** Writes a whole conversation as this vendor's own thread, so a provider
   *  taking a conversation up resumes it natively instead of being told it
   *  (turn/thread-start.ts). Absent: the conversation is transferred as a
   *  prompt (turn/transfer.ts). See NativeThreadWriter for the contract. */
  writer?: NativeThreadWriter;
}

/** What ClikCode hands a writer for one write. */
export interface NativeThreadWriteContext {
  harness: AiLocalHarnessDefinition;
  /** The conversation's folder: the cwd the vendor resumes the thread in
   *  (Claude Code keys its project directory on it, Codex records it in
   *  session_meta). Absolute. */
  workspace: string;
  /** The environment the TAKING-OVER account runs this harness under --
   *  `turnEnvironment(harness, account)`: its profile variable
   *  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) and redirected HOME/XDG. Write
   *  only under the root this environment places (`root(environment)` of the
   *  same store), never under `process.env` or the real home: another account,
   *  or the user's own vendor history, must not see the thread. */
  environment: NativeSessionEnvironment;
  /** The model the thread will be resumed with, where the vendor records one
   *  per thread or per message. */
  model: string | null;
  /** The installed vendor build, as the first line of its `--version`
   *  (memoized per binary, harness/transport/native/version-memo.ts);
   *  undefined when it could not be read. */
  version: string | undefined;
}

/** The thread a writer made. */
export interface NativeThreadWritten {
  /** The id the vendor resumes it by (`--resume <id>`, ACP `session/load`).
   *  ClikCode stores it as the session's `nativeSessionId` and the first
   *  turn resumes it: the request is sent as the user typed it, the history
   *  is not retold. */
  nativeId: string;
  /** Only when the thread can be resumed by ONE transport (a file the ACP
   *  agent would not find, say): pins the session to it. Leave out when the
   *  harness's ACP and CLI read the same store. */
  transport?: 'acp' | 'structured-cli' | 'text-cli';
}

/** A vendor-native thread writer.
 *
 * Contract for writer authors:
 *
 * - **Input.** `write` gets the conversation's CanonicalRecord
 *   (session/canonical.ts): every turn in order -- the request (+ attachment
 *   paths), the answer as text and tool calls interleaved (`parts`), each
 *   call with ClikCode's category, the vendor's own tool name and bounded
 *   arguments where recorded (`name`/`input`; older calls have only `label`
 *   and `target`), bounded output, status and touched files, and which
 *   harness/model produced it. The last turn may be `interrupted`: write it as
 *   it stands (the partial answer, its calls); ClikCode then sends
 *   INTERRUPTED_TURN_REQUEST as the next prompt. Map foreign tool calls to
 *   this vendor's own tools where the model would otherwise disown them
 *   (Claude Code: Bash/Read/Edit), and write no thinking or encrypted
 *   reasoning (signatures cannot be forged).
 * - **Where.** A NEW thread with a fresh id, under the root
 *   `context.environment` places, in the layout this vendor reads -- index
 *   rows included (Codex: a stale `state_5.sqlite` `threads` row beats the
 *   file on disk). Never modify or delete an existing thread: the
 *   conversation's earlier branches still own theirs. Write atomically (a
 *   temporary name, then rename) so a half-written thread is never resumed.
 *   An import command (`opencode import`) must run with exactly
 *   `context.environment` and must not open a vendor session the user did not
 *   ask for.
 * - **Version gating.** `versionOk(context)` is asked before every write;
 *   answer true only for builds whose layout was verified (list them in
 *   `testedVersions`), false for anything else -- including an unknown
 *   version. False means a transfer, which always works; a thread written in
 *   a layout the vendor has since changed fails to resume, or resumes empty.
 * - **Return.** `{ nativeId }` once the thread is complete on disk;
 *   `undefined` when it cannot be done (nothing worth writing, an unexpected
 *   layout found on disk). Throwing is treated as undefined. Either way
 *   ClikCode falls back to the transfer for this turn and leaves nothing
 *   behind it relies on -- so clean up a partial write before returning.
 * - **Cost.** Runs before the first turn, on the user's clock: file writes
 *   or one import command, no model calls, no network. */
export interface NativeThreadWriter {
  /** Vendor builds this writer was verified against, for the record. */
  testedVersions: readonly string[];
  versionOk(context: NativeThreadWriteContext): boolean | Promise<boolean>;
  write(record: CanonicalRecord, context: NativeThreadWriteContext): Promise<NativeThreadWritten | undefined>;
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
