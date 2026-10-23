import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkUserDirectories } from './turn-environment.js';

describe('a profile that is the vendor\'s HOME', () => {
  it('retries linking after the profile directory is created', () => {
    const root = mkdtempSync(join(tmpdir(), 'clikcode-links-late-'));
    try {
      const real = join(root, 'home'); const profile = join(root, 'profile');
      mkdirSync(join(real, 'projects'), { recursive: true });
      linkUserDirectories(profile, real);
      mkdirSync(profile);
      linkUserDirectories(profile, real);
      expect(readlinkSync(join(profile, 'projects'))).toBe(join(real, 'projects'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('links the user\'s own folders, not their dot entries or files, and keeps what it has', () => {
    const root = mkdtempSync(join(tmpdir(), 'clikcode-links-'));
    try {
      const real = join(root, 'home'); const profile = join(root, 'profile');
      for (const dir of ['projects', 'Documents', '.ssh', '.config']) mkdirSync(join(real, dir), { recursive: true });
      writeFileSync(join(real, 'notes.txt'), 'x');
      mkdirSync(join(profile, 'Documents'), { recursive: true });
      linkUserDirectories(profile, real);
      expect(readlinkSync(join(profile, 'projects'))).toBe(join(real, 'projects'));
      expect(lstatSync(join(profile, 'Documents')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(profile, '.ssh'), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(profile, 'notes.txt'), { throwIfNoEntry: false })).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
