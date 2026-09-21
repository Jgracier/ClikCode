import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAttachmentPath, resolveStandaloneAttachment } from './session-attachments.js';

describe('interactive attachment paths', () => {
  it('decodes quoted and terminal-escaped paths without running a shell', () => {
    expect(decodeAttachmentPath('"/tmp/reference photo.png"')).toBe('/tmp/reference photo.png');
    expect(decodeAttachmentPath("'/tmp/reference photo.png'")).toBe('/tmp/reference photo.png');
    if (process.platform !== 'win32') {
      expect(decodeAttachmentPath('/tmp/reference\\ photo.png')).toBe('/tmp/reference photo.png');
    }
  });

  it('recognizes existing absolute, relative, quoted, and file URL references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-attachment-'));
    const image = join(directory, 'reference photo.png');
    await writeFile(image, 'image');
    try {
      await expect(resolveStandaloneAttachment(image, directory)).resolves.toBe(image);
      await expect(resolveStandaloneAttachment('./reference\\ photo.png', directory)).resolves.toBe(image);
      await expect(resolveStandaloneAttachment('"reference photo.png"', directory)).resolves.toBe(image);
      await expect(resolveStandaloneAttachment(pathToFileURL(image).href, directory)).resolves.toBe(image);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not turn ordinary text or nonexistent slash commands into attachments', async () => {
    await expect(resolveStandaloneAttachment('Please review this photo', process.cwd())).resolves.toBeUndefined();
    await expect(resolveStandaloneAttachment('/help', process.cwd())).resolves.toBeUndefined();
    await expect(resolveStandaloneAttachment('/definitely/not/a/photo.png', process.cwd())).resolves.toBeUndefined();
  });
});
