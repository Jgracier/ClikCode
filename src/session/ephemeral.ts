/** Conversations that have not been used yet.
 *
 * A new chat has to exist while it is open — slash commands and the turn
 * loop address it by id — but it is not a conversation until something
 * happens in it. Until then it lives in this process only. Nothing is
 * written, so leaving it is just forgetting it. There is no file to delete.
 *
 * Keyed by ClikCode's home directory: two tests, or two homes, do not share
 * a draft. */

import { cloneData } from './store/data.js';
import type { HarnessSession } from './model.js';
import { isBlankConversation } from './options.js';

const byHome = new Map<string, Map<string, HarnessSession>>();
/** Written even while still blank, because another process (the turn's
 * worker) has to be able to read the record. Cleared as soon as that write
 * returns. */
const forced = new Set<string>();

function homeKey(): string {
  return process.env.CLIKCODE_HOME?.trim() || 'default';
}

function overlay(): Map<string, HarnessSession> {
  const key = homeKey();
  let drafts = byHome.get(key);
  if (!drafts) byHome.set(key, drafts = new Map());
  return drafts;
}

export function ephemeralSessions(): HarnessSession[] {
  return [...overlay().values()].map((session) => cloneData(session));
}

/** Remember a draft, or forget it once it is a real conversation or has been
 * written. The stored copy is a clone: later edits to the caller's object
 * do not change what the next read will see until the next write. */
export function holdEphemeral(session: HarnessSession): void {
  if (!isBlankConversation(session) || forced.has(session.id)) {
    overlay().delete(session.id);
    return;
  }
  overlay().set(session.id, cloneData(session));
}

export function dropEphemeral(id: string): void {
  overlay().delete(id);
}

/** Drafts a client in this process is showing. A process used to show one
 * chat, so any draft missing from the state it wrote, or found by a new
 * chat's sweep, was one it had left. An editor's shared bridge shows several
 * at once (ide/bridge-mux.ts): one chat's write or new chat must not drop
 * another's draft. Pinned by the IDE bridge while shown, unpinned as it leaves. */
const pinned = new Set<string>();

export function pinDraft(id: string): void {
  pinned.add(id);
}

export function unpinDraft(id: string): void {
  pinned.delete(id);
}

export function draftPinned(id: string): boolean {
  return pinned.has(id);
}

export function forceStoreSession(id: string): void {
  forced.add(id);
}

export function unforceStoreSession(id: string): void {
  forced.delete(id);
}

export function sessionForceStored(id: string): boolean {
  return forced.has(id);
}

/** A draft this process holds, if `id` is one. */
export function ephemeralSession(id: string): HarnessSession | undefined {
  const session = overlay().get(id);
  return session ? cloneData(session) : undefined;
}

/** A newer build replacing this window (commands/ai/build-replace.ts)
 * hands the draft it was on to the new process here: a draft is never on
 * disk, so `sessions resume <id>` found nothing and the window came back on
 * a fresh chat saying "no chat matches". */
export const REEXEC_DRAFT_ENV = 'CLIKCODE_REEXEC_DRAFT';

/** The draft a replaced window handed over, held in this process as its
 * own. Read once; the variable goes, so no child inherits it. */
export function adoptHandedOverDraft(): void {
  const raw = process.env[REEXEC_DRAFT_ENV];
  delete process.env[REEXEC_DRAFT_ENV];
  if (!raw) return;
  try {
    const session = JSON.parse(raw) as HarnessSession;
    if (session && typeof session.id === 'string') holdEphemeral(session);
  } catch { /* fail-open-ok: without it the window opens a fresh chat */ }
}

/** What was typed into the composer while the old window was letting go (a re-exec awaits its workers and connections for a while, and
 * the keys of that moment went into a window that was about to be replaced). Handed to the new process the same way. */
export const REEXEC_TYPED_ENV = 'CLIKCODE_REEXEC_TYPED';

/** The text a replaced window had typed and not sent. Read once; the variable goes, so no child inherits it. */
export function adoptHandedOverTyped(): string | undefined {
  const text = process.env[REEXEC_TYPED_ENV];
  delete process.env[REEXEC_TYPED_ENV];
  return text || undefined;
}
