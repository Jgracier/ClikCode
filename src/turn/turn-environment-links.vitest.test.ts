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
  it('shows the user\'s own ClikDeploy and ClikCode folders as ~/.clikdeploy and ~/.clikcode, setting a stale copy aside', () => {
    const root = mkdtempSync(join(tmpdir(), 'clikcode-links-tools-'));
    try {
      const real = join(root, 'home'); const profile = join(root, 'profile');
      mkdirSync(join(real, '.clikdeploy'), { recursive: true });
      mkdirSync(join(real, '.clikcode'), { recursive: true });
      mkdirSync(join(real, '.gemini'), { recursive: true });
      mkdirSync(join(real, '.config', 'clikdeploy'), { recursive: true });
      mkdirSync(join(real, '.config', 'opencode'), { recursive: true });
      writeFileSync(join(real, '.clikdeploy', 'api-key'), 'k');
      // The stale copies a redirected run grew on its own.
      mkdirSync(join(profile, '.clikdeploy', 'ai'), { recursive: true });
      mkdirSync(join(profile, '.clikcode'), { recursive: true });
      writeFileSync(join(profile, '.clikcode', 'index.json'), '{}');
      linkUserDirectories(profile, real);
      expect(readlinkSync(join(profile, '.clikdeploy'))).toBe(join(real, '.clikdeploy'));
      expect(readlinkSync(join(profile, '.clikcode'))).toBe(join(real, '.clikcode'));
      // Nothing was deleted, and a vendor's own sign-in folder is still the profile's.
      expect(lstatSync(join(profile, '.clikcode.before-link', 'index.json')).isFile()).toBe(true);
      expect(lstatSync(join(profile, '.clikdeploy.before-link', 'ai')).isDirectory()).toBe(true);
      expect(readlinkSync(join(profile, '.config', 'clikdeploy'))).toBe(join(real, '.config', 'clikdeploy'));
      expect(lstatSync(join(profile, '.gemini'), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(profile, '.config', 'opencode'), { throwIfNoEntry: false })).toBeUndefined();
      // Run again: already linked, so nothing is moved a second time.
      linkUserDirectories(profile, real);
      expect(readlinkSync(join(profile, '.clikdeploy'))).toBe(join(real, '.clikdeploy'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
