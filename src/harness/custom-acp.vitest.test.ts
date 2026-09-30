import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiCustomAcpHarnessInput, AiLocalHarnessDefinition } from './definition.js';
import {
  addCustomAcpHarness, customAcpConfigPath, parseCustomAcpConfig, readCustomAcpConfig,
  reloadCustomAcpHarnesses, removeCustomAcpHarness, resetCustomAcpLoadForTests, writeCustomAcpConfig,
} from './custom-acp.js';

const previousHome = process.env.CLIKCODE_HOME;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cc-custom-acp-'));
  process.env.CLIKCODE_HOME = home;
  resetCustomAcpLoadForTests();
});

afterEach(async () => {
  process.env.CLIKCODE_HOME = previousHome;
  resetCustomAcpLoadForTests();
  await rm(home, { recursive: true, force: true });
});

describe('custom ACP harness file', () => {
  it('ignores a damaged file and rows that are not harnesses', () => {
    expect(parseCustomAcpConfig('{')).toEqual([]);
    expect(parseCustomAcpConfig(JSON.stringify({ harnesses: [{ command: 'ok', binary: 'ok', argv: ['--stdio', 1] }, 'nope'] }))).toEqual([
      { command: 'ok', binary: 'ok', argv: ['--stdio'] },
    ]);
  });

  it('adds, lists, replaces and removes a harness, and refuses a built-in name', async () => {
    const added = await addCustomAcpHarness({ command: '/My-Agent', binary: 'my-agent', argv: ['--stdio'], displayName: 'Mine' });
    expect(added).toMatchObject({ command: 'my-agent', provider: 'acp:my-agent', displayName: 'Mine', binary: 'my-agent' });
    expect(await readCustomAcpConfig()).toEqual([
      { command: 'my-agent', binary: 'my-agent', argv: ['--stdio'], displayName: 'Mine', provider: 'acp:my-agent' },
    ]);
    await addCustomAcpHarness({ command: 'my-agent', binary: 'other', argv: [] });
    expect(await readCustomAcpConfig()).toHaveLength(1);
    expect((await readCustomAcpConfig())[0]?.binary).toBe('other');
    expect(customAcpConfigPath()).toBe(join(home, 'custom-acp.json'));
    expect(await removeCustomAcpHarness('my-agent')).toBe(true);
    expect(await readCustomAcpConfig()).toEqual([]);
    expect(await removeCustomAcpHarness('my-agent')).toBe(false);
    await expect(addCustomAcpHarness({ command: 'claude', binary: 'evil', argv: [] })).rejects.toThrow(/built-in/);
  });

  it('registers the file on the catalog, and drops it when the file is removed', async () => {
    const seen: AiLocalHarnessDefinition[][] = [];
    const catalog = {
      customAcpHarness: (definition: AiCustomAcpHarnessInput) => ({ command: definition.command, binary: definition.binary, acp: { argv: definition.argv } }) as AiLocalHarnessDefinition,
      registerCustomHarnesses: (definitions: readonly AiLocalHarnessDefinition[]) => { seen.push([...definitions]); return definitions; },
    };
    reloadCustomAcpHarnesses(catalog);
    expect(seen).toEqual([]);
    await writeCustomAcpConfig([{ command: 'mine', binary: 'mine', argv: ['--stdio'] }]);
    reloadCustomAcpHarnesses(catalog);
    reloadCustomAcpHarnesses(catalog);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toMatchObject({ command: 'mine', binary: 'mine' });
    await writeCustomAcpConfig([]);
    reloadCustomAcpHarnesses(catalog);
    expect(seen.at(-1)).toEqual([]);
  });
});
