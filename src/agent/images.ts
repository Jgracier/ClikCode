/** Reads attached image files into inline `ImageInput`s for a model client
 * that can see them. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageInput } from './model-client.js';

export const IMAGE_MIME: Readonly<Record<string, string>> = {
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

/** The most of one picture a tool hands the model: 3.75 MB, which is 5 MB
 * as base64, the most Anthropic's models take per image (the Gateway may
 * route to one). Larger pictures are refused rather than break every later
 * request that carries them. */
export const MAX_TOOL_IMAGE_BYTES = 3.75 * 1024 * 1024;

/** The longest side a model takes (Anthropic refuses more than 8000 pixels). */
export const MAX_IMAGE_SIDE = 8000;

/** What a file's first bytes say it is (PNG, JPEG, GIF or WebP), with its
 * size in pixels when the header gives it. Undefined for anything else: a
 * file named .png that is not one would make every later request fail. */
export function sniffImage(bytes: Buffer): { mimeType: string; width?: number; height?: number } | undefined {
  const ascii = (start: number, end: number): string => bytes.subarray(start, end).toString('latin1');
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8') return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) return { mimeType: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && bytes.length >= 30) return { mimeType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
      return { mimeType: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    return { mimeType: 'image/webp' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // The frame header (SOFn, not DHT/JPG/DAC) carries the size.
    for (let offset = 2; offset + 9 <= bytes.length && bytes[offset] === 0xff;) {
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return { mimeType: 'image/jpeg' };
  }
  return undefined;
}
