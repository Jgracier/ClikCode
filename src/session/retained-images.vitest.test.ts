import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { retainUploadedImages } from './retained-images.js';
let root: string;
const previous = process.env.CLIKCODE_HOME;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'retain-')); process.env.CLIKCODE_HOME = join(root, 'state'); });
afterEach(async () => { if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous; await rm(root, { recursive: true, force: true }); });
it('retains submitted images after the viewer removes its temporary upload', async () => {
  const staging = join(root, 'clikcode-image.ABC'); await mkdir(staging);
  const source = join(staging, 'image.png'); await writeFile(source, 'image bytes');
  const retained = await retainUploadedImages(source, 'chat');
  expect(retained).not.toBe(source);
  expect(await readFile(retained, 'utf8')).toBe('image bytes');
  await rm(staging, { recursive: true, force: true });
  expect(await readFile(retained, 'utf8')).toBe('image bytes');
  expect(await retainUploadedImages(retained, 'chat')).toBe(retained);
});
it('does not move or rewrite ordinary user files', async () => {
  const file = join(root, 'image.png'); await writeFile(file, 'x');
  expect(await retainUploadedImages(`look ${file}`, 'chat')).toBe(`look ${file}`);
});
