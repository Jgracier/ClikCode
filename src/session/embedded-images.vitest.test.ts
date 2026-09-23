import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedImagePaths, queueAttachment } from './attachments.js';
import type { HarnessSession } from './model.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-embedded-'));
  await mkdir(join(dir, 'My Shots'));
  await writeFile(join(dir, 'shot.png'), 'x');
  await writeFile(join(dir, 'My Shots', 'screen one.png'), 'x');
  await writeFile(join(dir, 'notes.txt'), 'x');
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('an image named inside a message', () => {
  it('is found mid-sentence, with trailing punctuation', async () => {
    expect(await embeddedImagePaths(`why is ${join(dir, 'shot.png')}, broken?`, '/')).toEqual([join(dir, 'shot.png')]);
  });

  it('is found the way terminal drag-and-drop writes a path with spaces', async () => {
    const target = join(dir, 'My Shots', 'screen one.png');
    expect(await embeddedImagePaths(`look '${target}' here`, '/')).toEqual([target]);
    expect(await embeddedImagePaths(`look ${target.replace(/ /g, '\\ ')} here`, '/')).toEqual([target]);
  });

  it('is found relative to the workspace', async () => {
    expect(await embeddedImagePaths('compare ./shot.png please', dir)).toEqual([join(dir, 'shot.png')]);
  });

  it('is not invented from a word that only looks like one, or a file that is not an image', async () => {
    expect(await embeddedImagePaths('rename logo.png to icon.png', dir)).toEqual([]);
    expect(await embeddedImagePaths(`read ${join(dir, 'notes.txt')}`, '/')).toEqual([]);
  });

  it('is attached once however many times it is mentioned', async () => {
    const path = join(dir, 'shot.png');
    expect(await embeddedImagePaths(`${path} and again ${path}`, '/')).toEqual([path]);
  });
});

describe('attaching an image', () => {
  it('accepts a screenshot larger than the text-file limit', async () => {
    const big = join(dir, 'retina.png');
    await writeFile(big, Buffer.alloc(3 * 1024 * 1024));
    const session = {} as HarnessSession;
    await queueAttachment(session, big);
    expect(session.attachments).toEqual([big]);
  });

  it('still refuses a text file over 1 MiB', async () => {
    const big = join(dir, 'huge.txt');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    await expect(queueAttachment({} as HarnessSession, big)).rejects.toThrow(/1 MiB/);
  });
});
