import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerClikCodeCommands } from './register.js';

function program(): Command {
  const root = new Command('clikcode').exitOverride();
  registerClikCodeCommands(root, {} as never);
  return root;
}
const find = (root: Command, ...path: string[]): Command | undefined =>
  path.reduce<Command | undefined>((at, name) => at?.commands.find((c) => c.name() === name || c.aliases().includes(name)), root);
const hidden = (command: Command | undefined): boolean => Boolean((command as unknown as { _hidden?: boolean } | undefined)?._hidden);

describe('the public command surface', () => {
  it('keeps the ClikDeploy operator commands out of --help but runnable (the connector service runs connectors run --loop)', () => {
    const root = program();
    for (const path of [['connectors'], ['computer', 'queue'], ['computer', 'recipe'], ['computer', 'preflight'], ['computer', 'oauth-connect'], ['computer', 'proof'], ['computer', 'unattended']]) {
      expect(find(root, ...path), path.join(' ')).toBeDefined();
      expect(hidden(find(root, ...path)), path.join(' ')).toBe(true);
    }
    expect(find(root, 'connectors', 'run')?.options.map((option) => option.long)).toContain('--loop');
    expect(find(root, 'connectors', 'agent-mcp')).toBeDefined();
    expect(root.helpInformation()).not.toMatch(/connectors|mcp-serve/);
    expect(find(root, 'computer')!.helpInformation()).not.toMatch(/queue|recipe|preflight/);
    expect(hidden(find(root, 'computer', 'driver'))).toBe(false);
  });

  it('has one command for each thing', () => {
    const root = program();
    for (const gone of [['sessions', 'send'], ['sessions', 'chat'], ['sessions', 'set'], ['sessions', 'interactive'], ['sessions', 'slash'], ['gateway', 'models'], ['gateway', 'usage'], ['gateway', 'finetune'], ['conversations-mcp'], ['swarm-mcp']]) {
      expect(find(root, ...gone), gone.join(' ')).toBeUndefined();
    }
    expect(find(root, 'models')?.options.map((option) => option.long)).toContain('--gateway');
    expect(find(root, 'usage')?.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--gateway', '--days']));
    expect(find(root, 'finetune')?.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--cloud', '--hardware', '--rank']));
    expect(hidden(find(root, 'sessions', 'create'))).toBe(true);
  });

  it('refuses a fine-tune flag meant for the other place', async () => {
    await expect(program().parseAsync(['node', 'clikcode', 'finetune', 'data.jsonl', '--base', 'x', '--hardware', 'cpu'])).rejects.toThrow('--hardware is for --cloud only');
    await expect(program().parseAsync(['node', 'clikcode', 'finetune', 'data.jsonl', '--base', 'x', '--cloud', '--rank', '8'])).rejects.toThrow('--rank is for this computer only');
  });
});
