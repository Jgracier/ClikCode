/** Uploaded images become the conversation's files before a worker can use them.
 * Viewer lifetimes and SSH temporary directories must not own agent inputs. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { embeddedImageReferences } from './attachments.js';
import { safeRecordFileName, stateDirectory } from './store/paths.js';

export function conversationImagesDirectory(sessionId: string): string {
  return join(stateDirectory(), 'attachments', safeRecordFileName(sessionId));
}

export async function retainUploadedImages(text: string, sessionId: string): Promise<string> {
  let retained = text;
  for (const { token, path } of await embeddedImageReferences(text, process.cwd())) {
    if (!/\/clikcode-image\.[^/]+\/image\.(?:png|jpe?g|gif|webp)$/i.test(path)) continue;
    const bytes = await readFile(path);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Image attachments are limited to 20 MiB each.');
    const directory = conversationImagesDirectory(sessionId);
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
