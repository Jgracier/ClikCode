/** A Cursor account is named by the email its own sign-in saved, wherever
 * Cursor saved it. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveAccountLabel, nameAccount } from './labels.js';
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

describe('account naming at sign-in', () => {
  const codex = { provider: 'openai', displayName: 'Codex' };
  const accounts = [
    { id: '1', provider: 'openai', label: 'Codex 2' },
    { id: '2', provider: 'openai', label: 'a@example.com' },
    { id: '3', provider: 'anthropic', label: 'b@example.com' },
  ];

  it('numbers a placeholder with the first number nobody holds', () => {
    expect(nameAccount(accounts, codex)).toBe('Codex 1');
    expect(nameAccount([...accounts, { id: '4', provider: 'openai', label: 'codex 1' }], codex)).toBe('Codex 3');
  });

  it('keeps an email unique within one provider only', () => {
    expect(nameAccount(accounts, codex, 'b@example.com')).toBe('b@example.com');
    expect(nameAccount(accounts, codex, 'A@example.com')).toBe('A@example.com (2)');
    expect(nameAccount(accounts, codex, 'a@example.com', '2')).toBe('a@example.com');
  });
});
