/** Uploaded files become the conversation's files before a worker can use them.
 * Viewer lifetimes and SSH temporary directories must not own agent inputs. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { embeddedImageReferences } from './attachments.js';
import { safeRecordFileName, stateDirectory } from './store/paths.js';

function conversationAttachmentsDirectory(sessionId: string): string {
  return join(stateDirectory(), 'attachments', safeRecordFileName(sessionId));
}

/** Copies a file a device uploaded (ide/upload.ts) into the conversation and
 * returns where it now lives. The copy sits under its content hash, so the
 * same file sent twice is kept once, and keeps the name it was sent with, so
 * the agent sees `report.pdf` and not a hash. */
export async function retainUpload(path: string, name: string, sessionId: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  const directory = join(conversationAttachmentsDirectory(sessionId), hash.digest('hex').slice(0, 32));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, name);
  try { await copyFile(path, file, 1 /* COPYFILE_EXCL */); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return file;
}

export async function retainUploadedImages(text: string, sessionId: string): Promise<string> {
  let retained = text;
  for (const { token, path } of await embeddedImageReferences(text, process.cwd())) {
    if (!/\/clikcode-image\.[^/]+\/image\.(?:png|jpe?g|gif|webp)$/i.test(path)) continue;
    const bytes = await readFile(path);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Image attachments are limited to 20 MiB each.');
    const directory = conversationAttachmentsDirectory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${createHash('sha256').update(bytes).digest('hex')}${extname(path).toLowerCase()}`);
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    retained = retained.split(token).join(file);
  }
  // The uploader owns its staging path; other in-flight sends may still
  // reference it. Only the retained copy belongs to this conversation.
  return retained;
}
