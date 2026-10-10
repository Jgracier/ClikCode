/** The README's command reference is checked against the code it describes:
 * every slash command is in it, the counts it gives are the registry's, and
 * every `clikcode <command>` it names is one the program registers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { SLASH_COMMANDS, SLASH_PALETTE_PINNED } from '../tui/slash/registry.js';
import { buildBaseProgram } from './program.js';
import { registerClikCodeCommands } from './register.js';

const README = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8');
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

describe('README', () => {
  it('lists every slash command and alias, and no removed one', () => {
    for (const command of SLASH_COMMANDS) {
      expect(README, `/${command.name}`).toContain(`\`/${command.name}`);
      for (const alias of command.aliases) expect(README, `/${alias}`).toContain(`/${alias}`);
    }
    expect(README).not.toMatch(/`\/undo\b/);
    expect(README).not.toMatch(/`\/models`/);
  });

  it('gives the counts the registry has', () => {
    expect(README).toContain(`list of ClikCode's ${SLASH_COMMANDS.length} commands`);
    expect(README).toContain(`${WORDS[SLASH_PALETTE_PINNED.length]![0]!.toUpperCase()}${WORDS[SLASH_PALETTE_PINNED.length]!.slice(1)} are pinned`);
    expect(README).toContain(`it pins ${WORDS[SLASH_PALETTE_PINNED.length - 1]}`);
  });

  it('names only `clikcode` commands the program registers', () => {
    const program = buildBaseProgram();
    registerClikCodeCommands(program, {} as never);
    const names = (command: Command): string[] => [command.name(), ...command.aliases()];
    const top = new Map(program.commands.map((command) => [command.name(), command] as const));
    for (const command of program.commands) for (const alias of command.aliases()) top.set(alias, command);
    const used = [...README.matchAll(/`clikcode ([a-z-]+)(?: ([a-z-]+))?/g)];
    expect(used.length).toBeGreaterThan(10);
    for (const [, name, sub] of used) {
      const command = top.get(name!);
      expect(command, `clikcode ${name}`).toBeDefined();
      if (sub && command!.commands.length) expect(command!.commands.flatMap(names), `clikcode ${name} ${sub}`).toContain(sub);
    }
    // The runtime dependencies it names are package.json's.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const named = /declares only the runtime dependencies it loads\s+\(([^)]*)\)/.exec(README)?.[1]?.match(/`[^`]+`/g)?.map((name) => name.slice(1, -1));
    expect(named?.sort()).toEqual(Object.keys(pkg.dependencies).sort());
    // The removed ones stay removed.
    expect(README).not.toMatch(/clikcode gateway agents|clikcode plugin (?:add|marketplace)/);
  });
});
