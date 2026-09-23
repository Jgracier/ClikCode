/** One policy for every per-harness cache: what is derived from the vendor's
 * binary or files is remembered for exactly as long as they are unchanged --
 * no clock -- and an update invalidates it the moment it lands.
 *
 * Proved against a real executable on a real PATH rather than a mock, since
 * the whole point is what a stat of the actual file says. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNativeHarness, inspectNativeHarnessForPicker } from './transport/native/inspect.js';
import { rememberFallbackTurn, usesFallbackTurn } from '../turn/runtime.js';
import { nativeModelCatalog, nativeModelLabel } from './accounts/model-catalog.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from './definition.js';

let dir: string;
const previousPath = process.env.PATH;
let tick = 1_800_000_000;

/** Rewrite the fake CLI and move its mtime forward: what an update does. */
async function install(name: string, version: string, extra = ''): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n# ${extra}\necho "${name} ${version}"\n`);
  await chmod(path, 0o755);
  tick += 60;
  await utimes(path, tick, tick);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-cache-policy-'));
  process.env.PATH = `${dir}:${previousPath}`;
});

afterAll(async () => {
  process.env.PATH = previousPath;
  await rm(dir, { recursive: true, force: true });
});

describe('install and version', () => {
  const spec = { command: 'fakecli', binary: 'fakecli', displayName: 'Fake CLI', surface: 'terminal' as const };

  it('sees an update at once, not a minute later', async () => {
    await install('fakecli', '1.0.0');
    expect((await inspectNativeHarness(spec)).version).toContain('1.0.0');
    await install('fakecli', '2.0.0');
    // The 60-second clock this replaced would have answered 1.0.0 here.
    expect((await inspectNativeHarness(spec)).version).toContain('2.0.0');
  });

  it('sees an install at once, where it had said "not installed"', async () => {
    const later = { command: 'latecli', binary: 'latecli', displayName: 'Late CLI', surface: 'terminal' as const };
    expect((await inspectNativeHarnessForPicker(later)).installed).toBe(false);
    await install('latecli', '1.0.0');
    expect((await inspectNativeHarnessForPicker(later)).installed).toBe(true);
  });
});

describe('the compatibility turn', () => {
  const harness = { command: 'compatcli', binary: 'compatcli' } as AiLocalHarnessDefinition;

  it('is used for the build that rejected the experimental one, and only that build', async () => {
    await install('compatcli', '1.0.0');
    expect(await usesFallbackTurn(harness)).toBe(false);
    await rememberFallbackTurn(harness);
    expect(await usesFallbackTurn(harness)).toBe(true);
    // A newer build may accept the experimental contract. It gets asked.
    await install('compatcli', '2.0.0');
    expect(await usesFallbackTurn(harness)).toBe(false);
  });
});

describe('Claude\'s models', () => {
  const table = (opus: string, name: string): string =>
    `{id:"${opus}",family:"opus",display_name:"${name}",provider_ids:{}} latest_per_family:{opus:"${opus}",sonnet:"claude-sonnet-5"} {id:"claude-sonnet-5",family:"sonnet",display_name:"Sonnet 5",provider_ids:{}}`;

  it('follows the installed Claude Code across an update, with no clock involved', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'clikcode-claude-profile-'));
    // A harness named `claude` whose binary is this fake: the catalog reads
    // its alias table out of whatever file `claude` resolves to on PATH.
    const harness = { command: 'claude', binary: 'claude', displayName: 'Claude Code' } as AiLocalHarnessDefinition;
    const account = { id: 'a', provider: 'anthropic', label: 'work', models: [], status: 'ready', nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: profile } } as unknown as AiHarnessAccount;
    try {
      await install('claude', '2.1.279', table('claude-opus-5', 'Opus 5'));
      const before = await nativeModelCatalog(harness, account);
      expect(before.labels?.opus).toBe('Opus 5');
      expect(nativeModelLabel('claude', 'opus')).toBe('Opus 5');

      await install('claude', '2.1.280', table('claude-opus-5-5', 'Opus 5.5'));
      const after = await nativeModelCatalog(harness, account);
      expect(after.labels?.opus).toBe('Opus 5.5');
      expect(nativeModelLabel('claude', 'opus')).toBe('Opus 5.5');
      expect(after.models).toEqual(expect.arrayContaining(['opus', 'sonnet']));

      // Changing the vendor's own setting is a change too.
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      expect((await nativeModelCatalog(harness, account)).configured).toBe('sonnet');
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
