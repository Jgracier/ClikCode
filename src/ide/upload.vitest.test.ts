/** Files a chat on another device sends to this machine: staged privately, taken once by the turn that names them. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeUploads, ideUploadLimits, safeUploadName } from './upload.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');
let uploads: IdeUploads;
afterEach(async () => { await uploads?.close(); });

async function staged(name: string, body: string): Promise<string> {
  await uploads.start('upload-0001', name, Buffer.byteLength(body));
  await uploads.append('upload-0001', 0, b64(body));
  return uploads.finish('upload-0001');
}

describe('an upload from another device', () => {
  it('lands in a private file under the name it was sent with, and is handed over exactly once', async () => {
    uploads = new IdeUploads();
    const path = await staged('report.pdf', 'pdf bytes');
    expect(dirname(dirname(path))).toBe(tmpdir());
    expect(basename(path)).toBe('report.pdf');
    expect(await readFile(path, 'utf8')).toBe('pdf bytes');
    expect(uploads.claim(path)).toMatchObject({ path, name: 'report.pdf', image: false });
    expect(uploads.claim(path)).toBeUndefined();
  });

  it('knows an image from any other file', async () => {
    uploads = new IdeUploads();
    expect(uploads.claim(await staged('Photo.JPG', 'x'))).toMatchObject({ image: true });
  });

  it('never hands over a path it did not stage itself', async () => {
    uploads = new IdeUploads();
    await staged('a.txt', 'x');
    expect(uploads.claim('/etc/passwd')).toBeUndefined();
    expect(uploads.claim(`${tmpdir()}/clikcode-upload.forged/a.txt`)).toBeUndefined();
  });

  it('takes chunks in order only, and no more bytes than it was told to expect', async () => {
    uploads = new IdeUploads();
    await uploads.start('upload-0001', 'a.txt', 4);
    await expect(uploads.append('upload-0001', 2, b64('ab'))).rejects.toThrow('out of order');
    await uploads.append('upload-0001', 0, b64('ab'));
    await expect(uploads.append('upload-0001', 2, b64('abc'))).rejects.toThrow('chunk size');
    await expect(uploads.append('upload-0001', 2, 'not base64!')).rejects.toThrow('Invalid upload data');
    await expect(uploads.finish('upload-0001')).rejects.toThrow('before all bytes arrived');
  });

  it('holds an image to the image limit and any other file to the file limit', async () => {
    uploads = new IdeUploads();
    await expect(uploads.start('upload-0001', 'a.png', ideUploadLimits.maxImageBytes + 1)).rejects.toThrow('20 MiB');
    await expect(uploads.start('upload-0001', 'a.mp4', ideUploadLimits.maxFileBytes + 1)).rejects.toThrow('100 MiB');
    await expect(uploads.start('upload-0001', 'a.mp4', 0)).rejects.toThrow('empty');
    await uploads.start('upload-0001', 'a.mp4', ideUploadLimits.maxImageBytes + 1);
  });

  it('removes what was staged when the upload is aborted or the bridge closes', async () => {
    uploads = new IdeUploads();
    const kept = await staged('a.txt', 'x');
    await uploads.start('upload-0002', 'b.txt', 3);
    await uploads.abort('upload-0002');
    await uploads.close();
    expect(existsSync(kept)).toBe(false);
    expect(uploads.claim(kept)).toBeUndefined();
  });
});

describe('the name a sender gives a file', () => {
  it('is one safe path segment', () => {
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
    expect(safeUploadName('C:\\Users\\me\\clip.mov')).toBe('clip.mov');
    expect(safeUploadName('.bashrc')).toBe('bashrc');
    expect(safeUploadName('a\u0000b<c>.txt')).toBe('abc.txt');
    expect(safeUploadName('')).toBe('file');
    expect(safeUploadName(`${'n'.repeat(300)}.pdf`)).toHaveLength(120);
  });
});
