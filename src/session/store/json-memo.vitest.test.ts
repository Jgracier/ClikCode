import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonMemo } from './json-memo.js';

interface File { v: 1; entries: Record<string, { at: number; value: string }> }

// Two memos on one file stand for two ClikCode processes.
const open = () => jsonMemo<File>('memo.json', () => ({ v: 1, entries: {} }), (parsed) => {
  const file = parsed as File;
  return file.v === 1 && file.entries ? file : undefined;
});
const entry = (value: string, at = 1) => ({ at, value });

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-json-memo-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe('a memo shared by several processes', () => {
  it('a long-lived holder sees what another process wrote since, in the same object', async () => {
    const window = open();
    const other = open();
    const held = await window.load();
    expect(held.entries).toEqual({});
    (await other.load()).entries.a = entry('from other');
    other.changed();
    await other.save();
    expect(await window.load()).toBe(held);
    expect(held.entries.a).toEqual(entry('from other'));
  });

  it('saves merge: each keeps the entries it changed, and takes the rest from the file', async () => {
    await writeFile(join(root, 'memo.json'), JSON.stringify({ v: 1, entries: { shared: entry('old'), gone: entry('old') } }));
    const first = open();
    const second = open();
    await first.load();
    const mine = await second.load();
    const theirs = await first.load();
    theirs.entries.a = entry('a');
    theirs.entries.shared = entry('first', 2);
    delete theirs.entries.gone;
    first.changed();
    await first.save();
    // The second changed only its own entry: its older copies of the others
    // must not overwrite the first's.
    mine.entries.b = entry('b');
    second.changed();
    await second.save();
    const stored = JSON.parse(await readFile(join(root, 'memo.json'), 'utf8')) as File;
    expect(stored.entries).toEqual({ a: entry('a'), b: entry('b'), shared: entry('first', 2) });
  });

  it('unsaved changes survive a re-read caused by another process\'s write', async () => {
    const window = open();
    const other = open();
    const held = await window.load();
    held.entries.mine = entry('unsaved');
    window.changed();
    (await other.load()).entries.theirs = entry('saved');
    other.changed();
    await other.save();
    await window.load();
    expect(held.entries).toEqual({ mine: entry('unsaved'), theirs: entry('saved') });
    expect(window.dirty).toBe(true);
    await window.save();
    expect((await open().read())?.entries).toEqual({ mine: entry('unsaved'), theirs: entry('saved') });
  });

  it('an unchanged file costs no read: the held copy is returned as is', async () => {
    const window = open();
    const held = await window.load();
    held.entries.local = entry('not marked changed yet');
    expect((await window.load()).entries.local).toEqual(entry('not marked changed yet'));
  });
});
