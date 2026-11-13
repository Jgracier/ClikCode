import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeAccountProfile } from './profiles.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const profileOf = (id: string) => ({ nativeProfile: { env: 'VIBE_HOME', path: join(root, 'profiles', 'vibe', id) } });

describe('removing an account profile', () => {
  it('removes a profile holding directories the vendor left read-only', async () => {
    const { path } = profileOf('gone').nativeProfile;
    const cache = join(path, 'logs', 'plugins', 'packages', 'c3');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'plugin.json'), '{}');
    await chmod(cache, 0o555);
    try {
      expect(await purgeAccountProfile(profileOf('gone'), [])).toBe(path);
      expect(await readdir(join(root, 'profiles', 'vibe'))).toEqual([]);
    } finally {
      await chmod(cache, 0o755).catch(() => undefined); // fail-open-ok: already removed when the test passes
    }
  });

  it('leaves a profile another account still runs in, and anything outside ClikCode\'s own profiles', async () => {
    const { path } = profileOf('shared').nativeProfile;
    await mkdir(path, { recursive: true });
    expect(await purgeAccountProfile(profileOf('shared'), [{ id: 'other', ...profileOf('shared') }] as never)).toBeUndefined();
    const outside = join(root, 'elsewhere');
    await mkdir(outside);
    expect(await purgeAccountProfile({ nativeProfile: { env: 'VIBE_HOME', path: outside } }, [])).toBeUndefined();
    expect((await readdir(root)).sort()).toEqual(['elsewhere', 'profiles']);
  });
});
