import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountSignedOutOnDisk, versionFromOutput } from './account.js';

const previousHome = process.env.HOME;
let root: string | undefined;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('honest account status', () => {
  it('reads the version past a deprecation warning', () => {
    expect(versionFromOutput('DeprecationWarning: the old flag is deprecated\n1.4.2\n')).toBe('1.4.2');
    expect(versionFromOutput('warning: x 1.0 deprecated')).toBeUndefined();
  });

  it('calls a ready account signed out when the vendor keeps no credential on disk', async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-signed-out-'));
    process.env.HOME = root;
    const account = { id: 'j', provider: 'junie', label: 'j', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:junie' } as never;
    expect(await accountSignedOutOnDisk(account)).toBe(true);
  });
});
