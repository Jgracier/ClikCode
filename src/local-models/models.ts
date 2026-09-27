/** Getting a catalog model's files onto this machine.
 *
 * A model already on disk elsewhere -- fetched by hand or by another tool
 * into ~/Models, or a directory listed in CLIKCODE_LOCAL_MODEL_DIRS -- is
 * adopted instead of downloaded again: a file with the same name and size
 * is hashed, and only an exact SHA-256 match is used, hard-linked into
 * ClikCode's store (copied when it is on another disk). Anything else is
 * downloaded from the pinned Hugging Face revision. */

import { copyFile, link, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CatalogFile } from './catalog.js';
import { checkDiskSpace, downloadVerified, formatBytes, isDownloaded, sha256File } from './download.js';
import { modelsDir } from './paths.js';

export function modelFilePath(file: CatalogFile): string {
  return join(modelsDir(), file.repo.replace('/', '--'), file.revision.slice(0, 12), file.file);
}

export function huggingFaceUrl(file: CatalogFile): string {
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${encodeURIComponent(file.file)}`;
}

function adoptionDirs(): string[] {
  const configured = (process.env.CLIKCODE_LOCAL_MODEL_DIRS ?? '').split(delimiter).filter(Boolean);
  return [...configured, join(homedir(), 'Models')];
}

async function findBySizeAndName(directory: string, name: string, size: number, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name && (await stat(path).catch(() => undefined))?.size === size) found.push(path);
    else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.')) found.push(...await findBySizeAndName(path, name, size, depth - 1));
  }
  return found;
}

export interface FileProgress { message: string; bytes?: number; totalBytes?: number }

async function adopt(file: CatalogFile, destination: string, onProgress: (progress: FileProgress) => void): Promise<boolean> {
  for (const directory of adoptionDirs()) {
    for (const candidate of await findBySizeAndName(directory, file.file, file.sizeBytes, 4)) {
      onProgress({ message: `checking ${candidate}…`, bytes: 0, totalBytes: file.sizeBytes });
      const hash = await sha256File(candidate, (bytes) => onProgress({ message: `checking ${candidate}…`, bytes, totalBytes: file.sizeBytes }));
      if (hash !== file.sha256) continue;
      await mkdir(dirname(destination), { recursive: true });
      try { await link(candidate, destination); } catch {
        await checkDiskSpace(dirname(destination), file.sizeBytes);
        await copyFile(candidate, destination);
      }
      return true;
    }
  }
  return false;
}

/** The local path of one pinned file, fetching it if need be. */
export async function ensureModelFile(file: CatalogFile, onProgress: (progress: FileProgress) => void, signal?: AbortSignal): Promise<string> {
  const destination = modelFilePath(file);
  if (await isDownloaded(destination, file.sizeBytes)) return destination;
  if (await adopt(file, destination, onProgress)) return destination;
  const label = `downloading ${file.file} (${formatBytes(file.sizeBytes)})`;
  await downloadVerified({
    url: huggingFaceUrl(file), destination, sizeBytes: file.sizeBytes, sha256: file.sha256,
    onProgress: (progress) => onProgress({ message: label, ...progress }),
    onVerify: (progress) => onProgress({ message: `verifying ${file.file}…`, ...progress }),
    ...(signal ? { signal } : {}),
  });
  return destination;
}

/** Bytes still to fetch for these files (0 when all are present). */
export async function missingBytes(files: readonly CatalogFile[]): Promise<number> {
  let total = 0;
  for (const file of files) if (!await isDownloaded(modelFilePath(file), file.sizeBytes)) total += file.sizeBytes;
  return total;
}
