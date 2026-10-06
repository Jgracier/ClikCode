import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** A second copy of the module, with its own in-process lock queue: as far as
 * the lock goes, another ClikCode process. */
async function freshModule(): Promise<typeof import('./json-file.js')> {
  vi.resetModules();
  return import('./json-file.js');
}

describe('updateJsonFile', () => {
  it('keeps every change when two processes write the same file at once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-json-file-'));
    const file = join(dir, 'shared.json');
    const one = await freshModule();
    const two = await freshModule();
    await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? one : two).updateJsonFile(
      file, one.objectOrEmpty, (current) => ({ ...current, [`writer-${index}`]: true }),
    )));
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(Array.from({ length: 24 }, (_, index) => `writer-${index}`).sort());
  });

  it('leaves the file alone when nothing changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-json-file-'));
    const file = join(dir, 'shared.json');
    await writeFile(file, '{"kept":1}', 'utf8');
    const { updateJsonFile, objectOrEmpty } = await freshModule();
    expect(await updateJsonFile(file, objectOrEmpty, () => undefined)).toEqual({ kept: 1 });
    expect(await readFile(file, 'utf8')).toBe('{"kept":1}');
  });

  it('reads damage as empty only where the caller says so', async () => {
    const { objectOrEmpty } = await freshModule();
    expect(objectOrEmpty('{"a"')).toEqual({});
    expect(objectOrEmpty('[1]')).toEqual({});
    expect(objectOrEmpty(undefined)).toEqual({});
  });
});
