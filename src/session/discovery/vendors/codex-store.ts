/** Codex: `<CODEX_HOME>/sessions/<y>/<m>/<d>/rollout-<timestamp>-<id>.jsonl`.
 *
 * Date-partitioned, and the filename carries a timestamp the caller does not
 * know, so finding it is a search rather than a join -- locateCodexRollout
 * owns that. Moved here verbatim from an if-chain in locations.ts.
 *
 * Codex also indexes every thread in `<CODEX_HOME>/state_<n>.sqlite`
 * (`threads`, keyed by id, with the absolute `rollout_path`), and trusts that
 * row over the disk: a row pointing anywhere but the file fails a resume with
 * "no rollout found", while no row at all makes Codex scan and add one
 * (verified on 0.155.1). So a copied rollout is not carried until any row
 * for it points at the copy -- `reconcile`. */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';
import { locateCodexRollout } from './codex.js';

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; get(...p: unknown[]): unknown };
  close(): void;
};

/** The state databases a CODEX_HOME holds (`state_5.sqlite`, and whatever
 *  number a later Codex moves to), newest schema first. */
async function stateDatabases(codexHome: string): Promise<string[]> {
  const names = await readdir(codexHome).catch(() => [] as string[]);
  return names.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((left, right) => Number(right.match(/\d+/)![0]) - Number(left.match(/\d+/)![0]))
    .map((name) => join(codexHome, name));
}

/** Points every `threads` row for `nativeId` at `path`. True when no row
 *  points elsewhere afterwards (including: no row, no database). False when
 *  a stale row is there and could not be fixed -- the resume would fail. */
export async function reconcileCodexThreadRow(codexHome: string, nativeId: string, path: string): Promise<boolean> {
  for (const file of await stateDatabases(codexHome)) {
    let db: Db | undefined;
    try {
      const sqlite = await import('node:sqlite') as { DatabaseSync: new (p: string) => Db };
      db = new sqlite.DatabaseSync(file);
      // Codex may hold it open (WAL); wait for its write rather than fail.
      db.exec('PRAGMA busy_timeout = 3000');
      const hasThreads = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
      if (!hasThreads) continue;
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(nativeId) as { rollout_path?: unknown } | undefined;
      if (!row || row.rollout_path === path) continue;
      // Only the path: the row's name, pin and section are the account's own.
      db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(path, nativeId);
    } catch {
      // fail-open-ok: a stale row that cannot be fixed means the carry did not happen; the caller falls back.
      return false;
    } finally {
      try { db?.close(); } catch { /* fail-open-ok: the update already decided. */ }
    }
  }
  return true;
}

function codexHome(environment: NativeSessionEnvironment): string {
  return nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex'));
}

export const codexSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(codexHome(environment), 'sessions');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const path = await locateCodexRollout(root, nativeId);
    return path ? { path, root } : undefined;
  },
  reconcile({ nativeId, path, environment }) {
    return reconcileCodexThreadRow(codexHome(environment), nativeId, path);
  },
};
