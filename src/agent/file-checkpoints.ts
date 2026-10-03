/** Pre-image snapshots of every file a turn is about to write, so a turn can
 * be undone. Only harness write tools are tracked: whatever a bash command
 * changed is invisible here, and the undo result says so. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { realpathNearest } from './security.js';

interface CheckpointEntry {
  path: string;
  existed: boolean;
  mode?: number;
  /** sha256 of the pre-image; also the blob file name. */
  hash?: string;
  size?: number;
  /** The file as the turn left it, recorded when the turn ends (seal). Undo
   * refuses to overwrite a file that no longer matches it: that change came
   * after the turn, and undoing the turn must not destroy it. */
  after?: { existed: boolean; hash?: string };
}

interface CheckpointManifest {
  sessionId: string;
  turnId: string;
  createdAt: string;
  entries: CheckpointEntry[];
}

interface CheckpointTurnSummary {
  turnId: string;
  createdAt: string;
  files: string[];
  bytes: number;
}

export interface UndoResult {
  turnIds: string[];
  restored: string[];
  deleted: string[];
  failed: { path: string; reason: string }[];
  text: string;
}

interface UndoOptions {
  roots?: readonly string[];
  /** Exactly these turns (newest first), instead of the last `count`. */
  turnIds?: readonly string[];
  /** Restore even files changed since the turn (the user said so). */
  force?: boolean;
}

const BASH_UNDO_CAVEAT = 'Only changes made through the file tools were reverted. Anything a shell command changed (generated files, installs, git operations) was NOT tracked and is unchanged.';

class OutsideRootsError extends Error {
  constructor() { super('outside the allowed roots (the conversation\'s workspace); not touched'); }
}

const RETAIN_TURNS = 50;
const RETAIN_BYTES = 200 * 1024 * 1024;

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`Invalid checkpoint identifier: ${value}`);
  return cleaned;
}

async function currentState(file: string): Promise<{ existed: boolean; hash?: string }> {
  try {
    const content = await fs.readFile(file);
    return { existed: true, hash: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { existed: false };
    throw error;
  }
}

export function newTurnId(now: Date = new Date()): string {
  // Sortable prefix keeps listTurns() chronological without reading manifests.
  return `${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
}

export class FileCheckpointStore {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, private readonly limits: { turns?: number; bytes?: number } = {}) {
    this.root = path.join(stateDir, 'checkpoints');
  }

  private turnDir(sessionId: string, turnId: string): string {
    return path.join(this.root, safeSegment(sessionId), safeSegment(turnId));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readManifest(sessionId: string, turnId: string): Promise<CheckpointManifest | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.turnDir(sessionId, turnId), 'manifest.json'), 'utf8')) as CheckpointManifest;
      if (!Array.isArray(parsed.entries)) throw new Error('checkpoint manifest has no entries array');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Record the pre-image of `absolutePath` for this turn. The FIRST snapshot
   * of a path within a turn wins, so undo returns to the state before the
   * turn rather than to some intermediate edit. */
  snapshot(sessionId: string, turnId: string, absolutePath: string): Promise<void> {
    return this.serial(async () => {
      const target = path.resolve(absolutePath);
      const dir = this.turnDir(sessionId, turnId);
      await fs.mkdir(path.join(dir, 'blobs'), { recursive: true, mode: 0o700 });
      const manifest = await this.readManifest(sessionId, turnId)
        ?? { sessionId, turnId, createdAt: new Date().toISOString(), entries: [] };
      if (manifest.entries.some((entry) => entry.path === target)) return;
      let entry: CheckpointEntry = { path: target, existed: false };
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          const content = await fs.readFile(target);
          const hash = createHash('sha256').update(content).digest('hex');
          const blob = path.join(dir, 'blobs', hash);
          await fs.writeFile(blob, content, { mode: 0o600, flag: 'w' });
          entry = { path: target, existed: true, mode: stat.mode & 0o7777, hash, size: content.length };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      manifest.entries.push(entry);
      const manifestPath = path.join(dir, 'manifest.json');
      await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await fs.rename(`${manifestPath}.tmp`, manifestPath);
    });
  }

  /** Record how the turn left every file it snapshotted. Called once the
   * turn ends, however it ends. */
  seal(sessionId: string, turnId: string): Promise<void> {
    return this.serial(async () => {
      const manifest = await this.readManifest(sessionId, turnId);
      if (!manifest?.entries.length) return;
      for (const entry of manifest.entries) entry.after = await currentState(entry.path);
      const manifestPath = path.join(this.turnDir(sessionId, turnId), 'manifest.json');
      await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await fs.rename(`${manifestPath}.tmp`, manifestPath);
    });
  }

  async listTurns(sessionId: string): Promise<CheckpointTurnSummary[]> {
    let names: string[];
    try { names = await fs.readdir(path.join(this.root, safeSegment(sessionId))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: CheckpointTurnSummary[] = [];
    for (const turnId of names.sort()) {
      const manifest = await this.readManifest(sessionId, turnId);
      if (!manifest || !manifest.entries.length) continue;
      out.push({
        turnId, createdAt: manifest.createdAt,
        files: manifest.entries.map((entry) => entry.path),
        bytes: manifest.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
      });
    }
    return out;
  }

  undoTurn(sessionId: string, options: UndoOptions = {}): Promise<UndoResult> {
    return this.undo(sessionId, 1, options);
  }

  /** Revert the last `count` turns, newest first. With `roots`, any recorded
   * path that is not inside one of them is refused rather than written. */
  undo(sessionId: string, count = 1, options: UndoOptions = {}): Promise<UndoResult> {
    return this.serial(async () => {
      const result: UndoResult = { turnIds: [], restored: [], deleted: [], failed: [], text: '' };
      const listed = (await this.listTurns(sessionId)).reverse();
      const turns = options.turnIds
        ? listed.filter((turn) => options.turnIds!.includes(turn.turnId))
        : listed.slice(0, Math.max(1, Math.floor(count)));
      for (const turn of turns) {
        const manifest = await this.readManifest(sessionId, turn.turnId);
        if (!manifest) continue;
        const dir = this.turnDir(sessionId, turn.turnId);
        const kept: CheckpointEntry[] = [];
        for (const entry of [...manifest.entries].reverse()) {
          try {
            await this.restoreEntry(dir, entry, options);
            (entry.existed ? result.restored : result.deleted).push(entry.path);
          } catch (error) {
            // Outside the roots can never be restored here: dropped, or the
            // turn would stay first in line for every /undo after it.
            if (!(error instanceof OutsideRootsError)) kept.unshift(entry);
            result.failed.push({ path: String(entry.path), reason: error instanceof Error ? error.message : String(error) });
          }
        }
        result.turnIds.push(turn.turnId);
        // A turn that could not be fully restored keeps the snapshots of the
        // files it could not: those that were restored are done, and must
        // not read as "changed since" on the next try.
        if (!kept.length) await fs.rm(dir, { recursive: true, force: true });
        else if (kept.length < manifest.entries.length) {
          const manifestPath = path.join(dir, 'manifest.json');
          await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify({ ...manifest, entries: kept }, null, 2), { mode: 0o600 });
          await fs.rename(`${manifestPath}.tmp`, manifestPath);
        }
      }
      const parts = result.turnIds.length
        ? [`Undid ${result.turnIds.length} turn${result.turnIds.length === 1 ? '' : 's'}: ${result.restored.length} file(s) restored, ${result.deleted.length} created file(s) removed.`]
        : ['Nothing to undo: no file changes are recorded for this session.'];
      if (result.failed.length) parts.push(`Could not restore: ${result.failed.map((item) => `${item.path} (${item.reason})`).join('; ')}`);
      if (result.turnIds.length) parts.push(BASH_UNDO_CAVEAT);
      result.text = parts.join('\n');
      return result;
    });
  }

  private async restoreEntry(dir: string, entry: CheckpointEntry, options: UndoOptions): Promise<void> {
    // The manifest is data on disk; treat it as untrusted. Only an absolute,
    // normalized path that the manifest itself recorded is ever written, and a
    // blob name must be a bare sha256 so it cannot traverse out of `blobs/`.
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path) {
      throw new Error('refusing to restore a non-normalized path');
    }
    // Where a write lands NOW: a directory on the way may have become a
    // symlink since the snapshot, and the path as written would follow it.
    const target = realpathNearest(path.resolve(entry.path));
    if (options.roots && !options.roots.some((root) => {
      const rel = path.relative(realpathNearest(path.resolve(root)), target);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    })) {
      throw new OutsideRootsError();
    }
    if (!options.force) {
      if (!entry.after) throw new Error('the turn did not finish recording its changes; restore it only if you are sure');
      const now = await currentState(target);
      if (now.existed !== entry.after.existed || now.hash !== entry.after.hash) throw new Error('changed since that turn; not overwritten');
    }
    if (!entry.existed) {
      await fs.rm(target, { force: true });
      return;
    }
    if (!entry.hash || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('snapshot blob reference is invalid');
    const content = await fs.readFile(path.join(dir, 'blobs', entry.hash));
    if (createHash('sha256').update(content).digest('hex') !== entry.hash) throw new Error('snapshot blob is corrupt');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    // Restore ordinary read/execute bits but never set write access for group/other
    // or carry privileged sticky/set-id bits out of an untrusted manifest.
    if (typeof entry.mode === 'number') await fs.chmod(target, entry.mode & 0o755);
  }

  /** Drop the oldest turns beyond the retention cap (count and bytes). */
  prune(sessionId: string): Promise<string[]> {
    return this.serial(async () => {
      const maxTurns = this.limits.turns ?? RETAIN_TURNS;
      const maxBytes = this.limits.bytes ?? RETAIN_BYTES;
      const turns = (await this.listTurns(sessionId)).reverse();
      const removed: string[] = [];
      let bytes = 0;
      for (const [index, turn] of turns.entries()) {
        bytes += turn.bytes;
        if (index === 0 || (index < maxTurns && bytes <= maxBytes)) continue;
        await fs.rm(this.turnDir(sessionId, turn.turnId), { recursive: true, force: true });
        removed.push(turn.turnId);
      }
      return removed;
    });
  }
}
