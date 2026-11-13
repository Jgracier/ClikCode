import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/** Files a chat on another device sends to this machine, staged privately
 * until the turn that names them takes them (`send.attachments`).
 *
 * An image is something the model is shown, so it keeps the 20 MiB ceiling the
 * turn pipeline has for images. Anything else (a video, a recording, a PDF) is
 * a file the agent opens with its own tools, so its ceiling is only what a
 * phone can reasonably send over a JSON-lines connection. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_OPEN_UPLOADS = 4;
/** An upload nobody continues, or a finished one no turn takes. */
const ABANDONED_MS = 2 * 60_000;

export const ideUploadLimits = { maxImageBytes: MAX_IMAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, maxChunkBytes: MAX_CHUNK_BYTES } as const;

/** A finished upload, handed to the turn that attached it. The turn owns `directory` from then on. */
export interface StagedUpload {
  path: string;
  directory: string;
  /** The name the sender gave it, made safe to be a file name. */
  name: string;
  image: boolean;
}

interface OpenUpload extends StagedUpload {
  handle: FileHandle;
  size: number;
  written: number;
  expires: NodeJS.Timeout;
}

/** The sender's file name as one path segment: no directories, no control
 * characters, not hidden, and short enough for any file system. */
export function safeUploadName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  const extension = extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - extname(base).length).slice(0, 120 - extension.length);
  return `${stem || 'file'}${extension}`;
}

export class IdeUploads {
  private readonly open = new Map<string, OpenUpload>();
  private readonly finished = new Map<string, StagedUpload & { expires: NodeJS.Timeout }>();

  async start(id: string, name: string, size: number): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid upload id.');
    if (this.open.has(id)) throw new Error('That upload is already open.');
    if (this.open.size >= MAX_OPEN_UPLOADS) throw new Error('Too many files are uploading at once.');
    const safe = safeUploadName(String(name));
    const image = IMAGE_EXTENSIONS.has(extname(safe).toLowerCase());
    const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('An attachment cannot be empty.');
    if (size > limit) throw new Error(image ? 'Images are limited to 20 MiB each.' : 'Files are limited to 100 MiB each.');
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-upload.'));
    try {
      const path = join(directory, safe);
      const handle = await open(path, 'wx', 0o600);
      this.open.set(id, { path, directory, name: safe, image, handle, size, written: 0, expires: this.abandon(() => this.abort(id)) });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async append(id: string, offset: number, encoded: string): Promise<void> {
    const upload = this.open.get(id);
    if (!upload) throw new Error('That upload expired. Try again.');
    if (!Number.isSafeInteger(offset) || offset !== upload.written) throw new Error('Upload arrived out of order.');
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid upload data.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES || upload.written + bytes.length > upload.size) throw new Error('Invalid upload chunk size.');
    await upload.handle.write(bytes, 0, bytes.length, upload.written);
    upload.written += bytes.length;
    clearTimeout(upload.expires);
    upload.expires = this.abandon(() => this.abort(id));
  }

  /** The staged path, to be named in `send.attachments`. */
  async finish(id: string): Promise<string> {
    const upload = this.open.get(id);
    if (!upload) throw new Error('That upload expired. Try again.');
    if (upload.written !== upload.size) throw new Error('Upload ended before all bytes arrived.');
    this.open.delete(id);
    clearTimeout(upload.expires);
    await upload.handle.close();
    const { path, directory, name, image } = upload;
    this.finished.set(path, { path, directory, name, image, expires: this.abandon(() => this.discard(path)) });
    return path;
  }

  /** Hands a finished upload to the turn attaching it. Only a path this bridge
   * staged itself can be attached: undefined for anything else. */
  claim(path: string): StagedUpload | undefined {
    const staged = this.finished.get(path);
    if (!staged) return undefined;
    this.finished.delete(path);
    clearTimeout(staged.expires);
    const { expires: _expires, ...upload } = staged;
    return upload;
  }

  async abort(id: string): Promise<void> {
    const upload = this.open.get(id);
    if (!upload) return;
    this.open.delete(id);
    clearTimeout(upload.expires);
    await upload.handle.close().catch(() => undefined);
    await rm(upload.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.abort(id)));
    await Promise.all([...this.finished.keys()].map((path) => this.discard(path)));
  }

  private async discard(path: string): Promise<void> {
    const staged = this.claim(path);
    if (staged) await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private abandon(drop: () => Promise<void>): NodeJS.Timeout {
    const timer = setTimeout(() => { void drop(); }, ABANDONED_MS);
    timer.unref?.();
    return timer;
  }
}
