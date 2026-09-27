/** Fetching a large pinned file: resumable, hash-checked, and refused up
 * front when the disk cannot hold it.
 *
 * The file is written to `<name>.part` and renamed only once its SHA-256
 * matches, so a file at its final name is always a verified one and the
 * next run can trust it by size alone. An interrupted download resumes from
 * the partial file with an HTTP Range request; a server that ignores the
 * range (answers 200) gets the file restarted, not appended to. */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export interface DownloadProgress { bytes: number; totalBytes: number }

export interface DownloadRequest {
  url: string;
  destination: string;
  sizeBytes: number;
  sha256: string;
  onProgress?: (progress: DownloadProgress) => void;
  /** Called while an already-complete file is hashed, which for a large
   * model takes long enough to need saying. */
  onVerify?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Free bytes on the disk that holds `directory` (or its nearest existing
 * parent). Undefined where statfs is unsupported; the check is then skipped
 * rather than blocking the download. */
export async function freeDiskBytes(directory: string): Promise<number | undefined> {
  let target = directory;
  while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
  const disk = await statfs(target).catch(() => undefined);
  return disk ? disk.bavail * disk.bsize : undefined;
}

/** A model is gigabytes; failing at 90% for want of space wastes the wait.
 * 1 GB beyond the file itself keeps the disk usable afterwards. */
export async function checkDiskSpace(directory: string, bytesNeeded: number): Promise<void> {
  const free = await freeDiskBytes(directory);
  const needed = bytesNeeded + 1e9;
  if (free !== undefined && free < needed) {
    throw new Error(`Needs ${formatBytes(needed)} free on the disk holding ${directory}; ${formatBytes(free)} is free.`);
  }
}

export async function sha256File(path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  let reported = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
    if (onProgress && bytes - reported >= 256 * 1024 * 1024) { reported = bytes; onProgress(bytes); }
  }
  return hash.digest('hex');
}

/** Whether a finished file is present. Size alone: a file only reaches its
 * final name after its hash matched. */
export async function isDownloaded(destination: string, sizeBytes: number): Promise<boolean> {
  return (await stat(destination).catch(() => undefined))?.size === sizeBytes;
}

export async function downloadVerified(request: DownloadRequest): Promise<void> {
  const { url, destination, sizeBytes, sha256 } = request;
  if (await isDownloaded(destination, sizeBytes)) return;
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  let offset = (await stat(partial).catch(() => undefined))?.size ?? 0;
  if (offset > sizeBytes) { await rm(partial, { force: true }); offset = 0; }
  await checkDiskSpace(dirname(destination), sizeBytes - offset);

  if (offset < sizeBytes) {
    const response = await fetch(url, {
      headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
      redirect: 'follow',
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (response.status === 416 && offset > 0) {
      // The range starts at the end: the partial file is already whole.
    } else if (!response.ok || !response.body) {
      throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
    } else {
      if (response.status !== 206) offset = 0;
      const out = createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' });
      let bytes = offset;
      let lastReport = 0;
      const body = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
      try {
        for await (const chunk of body) {
          const buffer = chunk as Buffer;
          if (!out.write(buffer)) await new Promise<void>((resolve) => out.once('drain', resolve));
          bytes += buffer.length;
          const now = Date.now();
          if (now - lastReport >= 500) { lastReport = now; request.onProgress?.({ bytes, totalBytes: sizeBytes }); }
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      }
      request.onProgress?.({ bytes, totalBytes: sizeBytes });
    }
  }

  const size = (await stat(partial)).size;
  if (size !== sizeBytes) {
    throw new Error(`Download of ${url} ended at ${formatBytes(size)} of ${formatBytes(sizeBytes)}; it resumes from there next time.`);
  }
  const actual = await sha256File(partial, (bytes) => request.onVerify?.({ bytes, totalBytes: sizeBytes }));
  if (actual !== sha256) {
    // A corrupt partial file would otherwise be resumed forever.
    await rm(partial, { force: true });
    throw new Error(`Downloaded file failed its integrity check (sha256 ${actual}, expected ${sha256}); it was removed.`);
  }
  await rename(partial, destination);
}
