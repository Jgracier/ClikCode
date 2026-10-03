/** `clikcode sessions create` is a whole process: the chat it prints must be
 * one the next command can find, though nothing has been said in it yet.
 * Runs the built CLI (dist) against a throwaway CLIKCODE_HOME. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cc-sessions-create-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const clikcode = (...args: string[]): { session: { id: string } } => JSON.parse(execFileSync(process.execPath, [entry, ...args], {
  encoding: 'utf8', env: { ...process.env, CLIKCODE_HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') },
}));

describe('sessions create', () => {
  it('stores the chat it reports, so the next command finds it by id', () => {
    const { session } = clikcode('sessions', 'create', '--route', 'gateway');
    expect(clikcode('sessions', 'show', session.id).session.id).toBe(session.id);
  }, 60_000);
});
