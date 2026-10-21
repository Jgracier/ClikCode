import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepState, pathsInUse } from './state-sweep.js';

const DAY = 86_400_000;
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLIKCODE_HOME;
  home = mkdtempSync(join(tmpdir(), 'clikcode-sweep-'));
  process.env.CLIKCODE_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

/** A file or directory (with a file in it) `ageDays` old, made in the state directory. */
function make(relative: string, ageDays: number, directory = false): string {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  if (directory) { mkdirSync(path); writeFileSync(join(path, 'inside'), 'x'); } else writeFileSync(path, 'x');
  const when = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, when, when);
  return path;
}

describe('state sweep', () => {
  it('removes old temp entries and stale notes, keeps recent ones, conversation directories and everything else', async () => {
    const oldFile = make('t/aaaaaaaa/old.txt', 4);
    const oldDir = make('t/aaaaaaaa/old-build', 5, true);
    const recent = make('t/aaaaaaaa/recent', 1, true);
    const busy = make('t/bbbbbbbb/busy-build', 9, true);
    const staleNote = make('resource-notes/s1.json', 8);
    const freshNote = make('resource-notes/s2.json', 1);
    const staleWarning = make('io-guard-warnings/s1.global', 8);
    const freshWarning = make('io-guard-warnings/s2.global', 1);
    const history = make('sessions/chat.json', 60);
    const profile = make('profiles/kiro/state', 60, true);

    const result = await sweepState({ used: () => [join(busy, 'inside')] });

    expect(result).toEqual({ ran: true, removed: 4 });
    for (const gone of [oldFile, oldDir, staleNote, staleWarning]) expect(existsSync(gone)).toBe(false);
    for (const kept of [recent, busy, freshNote, freshWarning, history, profile, join(home, 't/aaaaaaaa'), join(home, 't/bbbbbbbb')]) expect(existsSync(kept)).toBe(true);
  });

  it('removes only what is a week old where it cannot tell what a process is using', async () => {
    const fiveDays = make('t/aaaaaaaa/five-days', 5);
    const nineDays = make('t/aaaaaaaa/nine-days', 9);
    await sweepState({ used: () => undefined });
    expect(existsSync(fiveDays)).toBe(true);
    expect(existsSync(nineDays)).toBe(false);
  });

  it('does not sweep again within the hour, unless forced', async () => {
    expect((await sweepState({ used: () => [] })).ran).toBe(true);
    const old = make('t/aaaaaaaa/old.txt', 10);
    expect(await sweepState({ used: () => [] })).toEqual({ ran: false, removed: 0 });
    expect(existsSync(old)).toBe(true);
    expect(await sweepState({ used: () => [], force: true })).toEqual({ ran: true, removed: 1 });
  });

  it('sees a directory this very process is working in', () => {
    const dir = make('t/cccccccc/cwd-here', 0, true);
    const before = process.cwd();
    try {
      process.chdir(dir);
      const used = pathsInUse(join(home, 't'));
      if (used === undefined) return; // no /proc here: nothing to assert
      expect(used.some((path) => path === dir || path.startsWith(`${dir}/`))).toBe(true);
    } finally {
      process.chdir(before);
    }
  });
});
