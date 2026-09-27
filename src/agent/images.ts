/** Reads attached image files into inline `ImageInput`s for a model client
 * that can see them. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageInput } from './model-client.js';

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

/** Matches the attachment limit, so anything the user could attach is sent. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Files that are missing, too large or not a known image type are skipped:
 * the prompt text still names every attached file, so the model can say it
 * could not see one rather than the turn failing before it starts. */
export async function readImageInputs(files: readonly string[]): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const file of files) {
    const mimeType = IMAGE_MIME[path.extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
      out.push({ mimeType, data: (await fs.readFile(file)).toString('base64'), name: path.basename(file) });
    } catch { /* fail-open-ok: the file name is still in the prompt text */ }
  }
  return out;
}
