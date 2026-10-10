/** What a foreground bash command changed in the workspace's git
 * repository, so the turn's undo checkpoint covers shell edits too (a `sed
 * -i` across many files is one undoable step) and the call shows its diff.
 *
 * Before the command: `git status` lists the dirty and untracked files, and
 * their bytes are kept (a clean file's bytes are already in the index).
 * After it: `git status` again, and every candidate is compared. A file
 * that was clean gets its pre-image from the index, one that was dirty from
 * the snapshot, one that did not exist is recorded as created. All of it
 * runs in ClikCode, outside the command and its sandbox.
 *
 * Not covered, by design: files git ignores, files outside the working
 * directory's subtree, and what git operations themselves move (a commit or
 * checkout leaves no dirty file behind to compare). */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PriorImage } from './file-checkpoints.js';
import { fileDiff, type FileDiff } from './line-diff.js';

/** Caps on the snapshot taken before every command. */
const SNAPSHOT_MAX_FILES = 500;
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
/** A file larger than this is neither snapshotted nor recorded. */
const FILE_MAX_BYTES = 2 * 1024 * 1024;
/** A status this long (a tree of unignored build output) is not tracked at all. */
const STATUS_MAX_ENTRIES = 20_000;
/** Caps on what one command records into the checkpoint. */
const RECORD_MAX_FILES = 200;
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
/** Files whose diff the call's row carries. */
const DIFF_MAX_FILES = 10;
const NAMES_SHOWN = 8;
const GIT_TIMEOUT_MS = 10_000;

/** A file as it was before the command: its bytes, or only enough to tell
 * that it changed (too large, or past the snapshot's caps). */
type Before =
  | { kind: 'missing' }
  | { kind: 'content'; content: Buffer; mode: number }
  | { kind: 'stat'; size: number; mtimeMs: number };

export interface ShellSnapshot {
  /** The repository's top level, real path; status paths are relative to it. */
  root: string;
  /** Status entries before the command, by repository-relative path. */
  dirty: Map<string, Before>;
  startedAt: number;
}

export interface ShellChanges {
  /** Every file the command changed, repository-relative. */
  changed: Array<{ path: string; change: 'add' | 'delete' | 'update' }>;
  /** How many of them the checkpoint could not take (caps, size, no pre-image). */
  unrecorded: number;
  images: Array<{ path: string; prior: PriorImage }>;
  diff: FileDiff[];
}

function git(cwd: string, args: string[], input?: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true,
        // No index.lock taken (a status must not collide with the user's own
        // git), and every path is a literal, never a glob.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
    } catch { resolve(undefined); return; }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks) : undefined); });
    if (input !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(input); }
  });
}

/** `git status --porcelain=v1 -z` for the working directory's subtree:
 * repository-relative path to its two-letter code. */
async function status(cwd: string): Promise<Map<string, string> | undefined> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', '.']);
  if (!out) return undefined;
  const fields = out.toString('utf8').split('\0');
  const entries = new Map<string, string>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.set(field.slice(3), code);
    // A staged rename or copy names its source in the next field.
    if (code[0] === 'R' || code[0] === 'C') index++;
    if (entries.size > STATUS_MAX_ENTRIES) return undefined;
  }
  return entries;
}

/** A regular file now: its bytes unless it is larger than the cap. Not a
 * regular file at all (a directory, a symlink) is 'other'. */
async function readRegular(file: string): Promise<{ content?: Buffer; mode: number; size: number; mtimeMs: number; ctimeMs: number } | 'missing' | 'other'> {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other';
  }
  if (!stat.isFile()) return 'other';
  if (stat.size > FILE_MAX_BYTES) return { mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  try {
    return { content: await fs.readFile(file), mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch { return 'other'; }
}

/** Before a foreground command: undefined when the working directory is
 * not in a git work tree (nothing is recorded then). */
export async function snapshotBeforeShell(cwd: string): Promise<ShellSnapshot | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const root = await fs.realpath(top.toString('utf8').trim()).catch(() => undefined);
  if (!root) return undefined;
  const startedAt = Date.now();
  const entries = await status(cwd);
  if (!entries) return undefined;
  const dirty = new Map<string, Before>();
  let files = 0;
  let bytes = 0;
  for (const rel of entries.keys()) {
    const now = await readRegular(path.join(root, rel));
    if (now === 'other') continue;
    if (now === 'missing') { dirty.set(rel, { kind: 'missing' }); continue; }
    if (now.content && files < SNAPSHOT_MAX_FILES && bytes + now.size <= SNAPSHOT_MAX_BYTES) { files++; bytes += now.size; dirty.set(rel, { kind: 'content', content: now.content, mode: now.mode }); }
    else dirty.set(rel, { kind: 'stat', size: now.size, mtimeMs: now.mtimeMs });
  }
  return { root, dirty, startedAt };
}

/** The index's copy of clean files, as the work tree holds them (the
 * checkout filters applied: line endings, LFS). Symlinks and submodules
 * are left out: they are not restored as files. */
async function indexImages(root: string, rels: string[]): Promise<Map<string, PriorImage & { existed: true }>> {
  const images = new Map<string, PriorImage & { existed: true }>();
  const usable = rels.filter((rel) => !rel.includes('\n'));
  if (!usable.length) return images;
  const listed = await git(root, ['ls-files', '-s', '-z', '--', ...usable]);
  if (!listed) return images;
  const blobs = new Map<string, { id: string; mode: number }>();
  for (const line of listed.toString('utf8').split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]+) 0\t(.+)$/s.exec(line);
    if (match && (match[1] === '100644' || match[1] === '100755')) blobs.set(match[3]!, { id: match[2]!, mode: Number.parseInt(match[1].slice(3), 8) });
  }
  const wanted = usable.filter((rel) => blobs.has(rel));
  if (!wanted.length) return images;
  // With --filters each line names the blob and, after a space, the path
  // whose attributes apply.
  const out = await git(root, ['cat-file', '--batch', '--filters'], wanted.map((rel) => `${blobs.get(rel)!.id} ${rel}\n`).join(''));
  if (!out) return images;
  let offset = 0;
  for (const rel of wanted) {
    const eol = out.indexOf(0x0a, offset);
    if (eol < 0) break;
    const header = /^[0-9a-f]+ blob (\d+)$/.exec(out.subarray(offset, eol).toString('utf8'));
    offset = eol + 1;
    if (!header) continue;
    const size = Number(header[1]);
    images.set(rel, { existed: true, content: Buffer.from(out.subarray(offset, offset + size)), mode: blobs.get(rel)!.mode });
    offset += size + 1;
  }
  return images;
}

function isText(content: Buffer): boolean {
  return !content.subarray(0, 8000).includes(0);
}

/** After the command: what it changed, the pre-images for the checkpoint,
 * and the diffs for its row. Paths in `changed` and the diffs are relative
 * to `cwd`. */
export async function shellChangesSince(snapshot: ShellSnapshot, cwd: string): Promise<ShellChanges | undefined> {
  const after = await status(cwd);
  if (!after) return undefined;
  const { root } = snapshot;
  type Found = { rel: string; change: 'add' | 'delete' | 'update'; prior?: PriorImage; fromIndex?: true; now?: Buffer };
  const found: Found[] = [];
  for (const [rel, before] of snapshot.dirty) {
    const now = await readRegular(path.join(root, rel));
    if (now === 'other') continue;
    if (before.kind === 'missing') {
      if (now !== 'missing') found.push({ rel, change: 'add', prior: { existed: false }, now: now.content });
      continue;
    }
    if (now === 'missing') {
      found.push({ rel, change: 'delete', ...(before.kind === 'content' ? { prior: { existed: true, content: before.content, mode: before.mode } } : {}) });
      continue;
    }
    if (before.kind === 'content') {
      if (!now.content || !now.content.equals(before.content)) found.push({ rel, change: 'update', prior: { existed: true, content: before.content, mode: before.mode }, now: now.content });
    } else if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
      found.push({ rel, change: 'update' });
    }
  }
  for (const [rel, code] of after) {
    if (snapshot.dirty.has(rel)) continue;
    const now = await readRegular(path.join(root, rel));
    if (now === 'other') continue;
    if (code === '??') {
      // New to the status but not to the disk (a .gitignore edit unhid it):
      // not created by this command, and undo must never delete it.
      if (now === 'missing' || now.ctimeMs < snapshot.startedAt - 1000) continue;
      found.push({ rel, change: 'add', prior: { existed: false }, now: now.content });
      continue;
    }
    // Was clean: its pre-image is the index's copy.
    found.push({ rel, change: now === 'missing' ? 'delete' : 'update', fromIndex: true, ...(now === 'missing' ? {} : { now: now.content }) });
  }
  if (!found.length) return { changed: [], unrecorded: 0, images: [], diff: [] };
  found.sort((a, b) => a.rel.localeCompare(b.rel));

  const fromIndex = await indexImages(root, found.filter((item) => item.fromIndex).slice(0, RECORD_MAX_FILES).map((item) => item.rel));
  for (const item of found) if (item.fromIndex) { const image = fromIndex.get(item.rel); if (image) item.prior = image; }

  const images: ShellChanges['images'] = [];
  const diff: FileDiff[] = [];
  let bytes = 0;
  let unrecorded = 0;
  const shown = (rel: string): string => path.relative(cwd, path.join(root, rel)) || rel;
  for (const item of found) {
    const size = item.prior?.existed ? item.prior.content.length : 0;
    if (!item.prior || images.length >= RECORD_MAX_FILES || bytes + size > RECORD_MAX_BYTES) { unrecorded++; continue; }
    bytes += size;
    images.push({ path: path.join(root, item.rel), prior: item.prior });
    if (diff.length >= DIFF_MAX_FILES) continue;
    const before = item.prior.existed ? item.prior.content : Buffer.alloc(0);
    // Too large to have been read: recorded, not drawn.
    if (item.change !== 'delete' && !item.now) continue;
    const now = item.now ?? Buffer.alloc(0);
    if (!isText(before) || !isText(now)) continue;
    diff.push(fileDiff(before.toString('utf8'), now.toString('utf8'), { path: shown(item.rel), numbered: true, change: item.change }));
  }
  return { changed: found.map((item) => ({ path: shown(item.rel), change: item.change })), unrecorded, images, diff };
}

/** The line the bash result ends with: which files the command changed,
 * and whether /undo covers them. */
export function describeShellChanges(changes: ShellChanges): string | undefined {
  const count = changes.changed.length;
  if (!count) return undefined;
  const mark = { add: '+', delete: '-', update: '' } as const;
  const names = changes.changed.slice(0, NAMES_SHOWN).map((item) => `${mark[item.change]}${item.path}`);
  const more = count > NAMES_SHOWN ? `, … ${count - NAMES_SHOWN} more` : '';
  const undo = changes.unrecorded
    ? `; ${changes.unrecorded} of them not recorded for /redo (too large, or past the per-command cap): revert those with git`
    : '';
  return `[changed ${count} file${count === 1 ? '' : 's'}: ${names.join(', ')}${more}${undo}]`;
}
