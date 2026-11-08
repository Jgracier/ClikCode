/** Getting a catalog model's files onto this machine.
 *
 * A model already on disk elsewhere -- fetched by hand or by another tool
 * into ~/Models -- is
 * adopted instead of downloaded again: a file with the same name and size
 * is hashed, and only an exact SHA-256 match is used, hard-linked into
 * ClikCode's store (copied when it is on another disk). Anything else is
 * downloaded from the pinned Hugging Face revision. */

import { quiet } from '../runtime/lifecycle-log.js';
import { copyFile, link, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CatalogFile, CatalogModel } from './catalog.js';
import { checkDiskSpace, downloadVerified, formatBytes, isDownloaded, sha256File } from './download.js';
import { modelsDir } from './paths.js';

/** A model stored as several GGUF parts (`…-00001-of-00003.gguf`): Hugging Face caps one file at 50 GB, so large models are published
 * split. Only a model discovered on this machine is (the published catalog's schema names one file); `weights` is then the first part,
 * with `sizeBytes` the whole model's, which is what fitting and speed read, and every part is here with its own size and hash. */
export type LocalModel = CatalogModel & { weightParts?: CatalogFile[] };

/** The files a model's weights are: its parts in order, or the one file. llama.cpp is given the first and finds the rest beside it. */
export function weightFiles(model: CatalogModel): CatalogFile[] {
  const parts = (model as LocalModel).weightParts;
  return parts?.length ? parts : [model.weights];
}

/** A file name a repo may carry: one folder at most, and no segment that is `.` or `..`, so it can never point outside the store. */
export function safeRepoPath(file: string): boolean {
  const segments = file.split('/');
  return segments.length <= 2 && segments.every((segment) => /^[\w.+-]+$/.test(segment) && !/^\.+$/.test(segment));
}

export function modelFilePath(file: CatalogFile): string {
  if (!safeRepoPath(file.file)) throw new Error(`refusing an unsafe model file name: ${file.file}`);
  return join(modelsDir(), file.repo.replace('/', '--'), file.revision.slice(0, 12), ...file.file.split('/'));
}

/** A Hub URL for a repo file, its path encoded segment by segment (an encoded `/` is not a folder to the Hub). */
export function hubFileUrl(repo: string, revision: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function huggingFaceUrl(file: CatalogFile): string {
  return hubFileUrl(file.repo, file.revision, file.file);
}

function adoptionDirs(): string[] {
  return [join(homedir(), 'Models')];
}

async function findBySizeAndName(directory: string, name: string, size: number, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name && (await stat(path).catch(quiet('local-models/models')))?.size === size) found.push(path);
    else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.')) found.push(...await findBySizeAndName(path, name, size, depth - 1));
  }
  return found;
}

interface FileProgress { message: string; bytes?: number; totalBytes?: number }

async function adopt(file: CatalogFile, destination: string, onProgress: (progress: FileProgress) => void): Promise<boolean> {
  for (const directory of adoptionDirs()) {
    for (const candidate of await findBySizeAndName(directory, basename(file.file), file.sizeBytes, 4)) {
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

/** The local path llama.cpp is given for a model's weights -- its first part -- fetching every part that is missing. */
export async function ensureModelWeights(model: CatalogModel, onProgress: (progress: FileProgress) => void, signal?: AbortSignal): Promise<string> {
  const files = weightFiles(model);
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    paths.push(await ensureModelFile(file, files.length > 1
      ? (progress) => onProgress({ ...progress, message: `${progress.message} (part ${index + 1} of ${files.length})` }) : onProgress, signal));
  }
  return paths[0]!;
}

/** Bytes still to fetch for these files (0 when all are present). */
export async function missingBytes(files: readonly CatalogFile[]): Promise<number> {
  let total = 0;
  for (const file of files) if (!await isDownloaded(modelFilePath(file), file.sizeBytes)) total += file.sizeBytes;
  return total;
}
