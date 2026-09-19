/** Pre-image snapshots of every file a turn is about to write, so a turn can
 * be undone. Only harness write tools are tracked: whatever a bash command
 * changed is invisible here, and the undo result says so. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CheckpointEntry {
  path: string;
  existed: boolean;
  mode?: number;
  /** sha256 of the pre-image; also the blob file name. */
  hash?: string;
  size?: number;
}

export interface CheckpointManifest {
  sessionId: string;
  turnId: string;
  createdAt: string;
  entries: CheckpointEntry[];
}

export interface CheckpointTurnSummary {
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

export interface UndoOptions { roots?: readonly string[] }

export const BASH_UNDO_CAVEAT = 'Only changes made through the file tools were reverted. Anything a shell command changed (generated files, installs, git operations) was NOT tracked and is unchanged.';

const RETAIN_TURNS = 50;
const RETAIN_BYTES = 200 * 1024 * 1024;

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`Invalid checkpoint identifier: ${value}`);
  return cleaned;
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
      return Array.isArray(parsed.entries) ? parsed : undefined;
    } catch { return undefined; }
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

  async listTurns(sessionId: string): Promise<CheckpointTurnSummary[]> {
    let names: string[];
    try { names = await fs.readdir(path.join(this.root, safeSegment(sessionId))); } catch { return []; }
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
      const turns = (await this.listTurns(sessionId)).reverse().slice(0, Math.max(1, Math.floor(count)));
      for (const turn of turns) {
        const manifest = await this.readManifest(sessionId, turn.turnId);
        if (!manifest) continue;
        const dir = this.turnDir(sessionId, turn.turnId);
        let clean = true;
        for (const entry of [...manifest.entries].reverse()) {
          try {
            await this.restoreEntry(dir, entry, options.roots);
            (entry.existed ? result.restored : result.deleted).push(entry.path);
          } catch (error) {
            clean = false;
            result.failed.push({ path: String(entry.path), reason: error instanceof Error ? error.message : String(error) });
          }
        }
        result.turnIds.push(turn.turnId);
        // A turn that could not be fully restored keeps its snapshots.
        if (clean) await fs.rm(dir, { recursive: true, force: true });
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

  private async restoreEntry(dir: string, entry: CheckpointEntry, roots?: readonly string[]): Promise<void> {
    // The manifest is data on disk; treat it as untrusted. Only an absolute,
    // normalized path that the manifest itself recorded is ever written, and a
    // blob name must be a bare sha256 so it cannot traverse out of `blobs/`.
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path) {
      throw new Error('refusing to restore a non-normalized path');
    }
    if (roots && !roots.some((root) => { const rel = path.relative(path.resolve(root), entry.path); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); })) {
      throw new Error('refusing to restore outside the allowed roots');
    }
    if (!entry.existed) {
      await fs.rm(entry.path, { force: true });
      return;
    }
    if (!entry.hash || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('snapshot blob reference is invalid');
    const content = await fs.readFile(path.join(dir, 'blobs', entry.hash));
    if (createHash('sha256').update(content).digest('hex') !== entry.hash) throw new Error('snapshot blob is corrupt');
    await fs.mkdir(path.dirname(entry.path), { recursive: true });
    await fs.writeFile(entry.path, content);
    if (typeof entry.mode === 'number') await fs.chmod(entry.path, entry.mode & 0o7777);
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
