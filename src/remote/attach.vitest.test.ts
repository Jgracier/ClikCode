/** A screenshot named in a message typed in a chat on another machine is put on that machine, and the message goes with its path there. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteImages } from './attach.js';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'cc-attach-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

const world = () => {
  const uploaded: Array<{ target: string; name: string; bytes: number }> = [];
  const removed: string[] = [];
  const images = new RemoteImages('devbox', () => folder,
    async (target, name, bytes) => { uploaded.push({ target, name, bytes: bytes.length }); return `/tmp/clikcode-image.AB${uploaded.length}/image.png`; },
    async (_target, path) => { removed.push(path); });
  return { images, uploaded, removed };
};
const shot = async (name: string, bytes = 5): Promise<string> => { const path = join(folder, name); await writeFile(path, Buffer.alloc(bytes, 1)); return path; };

describe('images named in a message sent to another machine', () => {
  it('are copied there once, and the message names them as they are there, the rest of it as typed', async () => {
    const { images, uploaded } = world();
    const path = await shot('Screen Shot.png', 9);
    const quoted = await images.forMachine(`look at '${path}' please`);
    expect(quoted).toBe('look at /tmp/clikcode-image.AB1/image.png please');
    expect(uploaded).toEqual([{ target: 'devbox', name: 'Screen Shot.png', bytes: 9 }]);
    // Dragged into a terminal: spaces escaped with backslashes. The same file again is not copied again.
    const escaped = await images.forMachine(`what is ${path.replace(/ /g, '\\ ')}, exactly?`);
    expect(escaped).toBe('what is /tmp/clikcode-image.AB1/image.png, exactly?');
    expect(uploaded).toHaveLength(1);
  });

  it('a path alone on a line is the image alone, as a chat here treats it', async () => {
    const { images } = world();
    expect(await images.forMachine(await shot('a.png'))).toBe('/tmp/clikcode-image.AB1/image.png');
  });

  it('leaves alone a word that only ends in .png, a path that is not a file here, and text with no image', async () => {
    const { images, uploaded } = world();
    expect(await images.forMachine('see logo.png and /nowhere/x.png and the notes')).toBe('see logo.png and /nowhere/x.png and the notes');
    expect(await images.forMachine('nothing to attach')).toBe('nothing to attach');
    expect(uploaded).toEqual([]);
  });

  it('copies several, each to its own place', async () => {
    const { images, uploaded } = world();
    const one = await shot('one.png');
    const two = await shot('two.jpg');
    expect(await images.forMachine(`${one} versus ${two}`)).toBe('/tmp/clikcode-image.AB1/image.png versus /tmp/clikcode-image.AB2/image.png');
    expect(uploaded.map((item) => item.name)).toEqual(['one.png', 'two.jpg']);
  });

  it('refuses one over 20 MiB, naming it, and sends nothing', async () => {
    const { images, uploaded } = world();
    const path = await shot('huge.png', 21 * 1024 * 1024);
    await expect(images.forMachine(`look ${path}`)).rejects.toThrow('huge.png is over 20 MiB');
    expect(uploaded).toEqual([]);
  });

  it('are taken off the machine when the chat is left, and only those', async () => {
    const { images, removed } = world();
    await images.forMachine(await shot('a.png'));
    await images.forMachine(await shot('b.png'));
    await images.release();
    expect(removed).toEqual(['/tmp/clikcode-image.AB1/image.png', '/tmp/clikcode-image.AB2/image.png']);
    await images.release();
    expect(removed).toHaveLength(2);
  });
});
