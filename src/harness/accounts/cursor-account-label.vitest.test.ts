/** A Cursor account is named by the email its own sign-in saved, wherever
 * Cursor saved it. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveAccountLabel } from './labels.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const cursor = { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', binary: 'cursor-agent' } as AiLocalHarnessDefinition;
const config = (email: string) => JSON.stringify({ version: 1, authInfo: { email, displayName: 'A', userId: 1 } });
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe('Cursor account names', () => {
  // An added account: ClikCode sets XDG_CONFIG_HOME inside the profile, and
  // Cursor (2026.09.26) saves cli-config.json there, not in ~/.cursor.
  it('reads the email an added account saved under its profile config', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-label-'));
    await mkdir(join(root, '.config', 'cursor'), { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.config', 'cursor', 'cli-config.json'), config('second@example.com'));
    expect(await deriveAccountLabel(cursor, root)).toBe('second@example.com');
  });

  // The main account: no XDG_CONFIG_HOME, so ~/.cursor.
  it('reads the email kept in .cursor when that is where it is', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-label-'));
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.cursor', 'cli-config.json'), config('main@example.com'));
    expect(await deriveAccountLabel(cursor, root)).toBe('main@example.com');
  });

  it('names nothing when no sign-in saved an email', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-label-'));
    expect(await deriveAccountLabel(cursor, root)).toBeUndefined();
  });
});
