import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  customCommandPrompt, discoverCustomCommands, expandCustomCommand, parseCustomCommandFile, resetCustomCommandCache,
  splitCommandArguments,
} from './custom-commands';

describe('custom command files', () => {
  it('parses optional frontmatter', () => {
    expect(parseCustomCommandFile('---\ndescription: "Ship a ticket"\nargument-hint: <ticket> [env]\n---\n\nShip $1 to $2.\n'))
      .toEqual({ description: 'Ship a ticket', argumentHint: '<ticket> [env]', body: 'Ship $1 to $2.' });
    expect(parseCustomCommandFile('Just a prompt.\n')).toEqual({ body: 'Just a prompt.' });
  });

  it('expands $ARGUMENTS and positional parameters', () => {
    expect(expandCustomCommand({ body: 'Fix $1 in $2. All: $ARGUMENTS' }, 'ABC-1 "the api"')).toBe('Fix ABC-1 in the api. All: ABC-1 "the api"');
    expect(expandCustomCommand({ body: 'Missing: [$3]' }, 'a b')).toBe('Missing: []');
    expect(splitCommandArguments(`one "two words" 'three four'`)).toEqual(['one', 'two words', 'three four']);
  });

  it('appends arguments to a template that has no placeholder, and keeps $& literal', () => {
    expect(expandCustomCommand({ body: 'Review the diff.' }, 'focus on auth')).toBe('Review the diff.\n\nfocus on auth');
    expect(expandCustomCommand({ body: 'Say: $ARGUMENTS' }, '$& $1')).toBe('Say: $& $1');
  });
});

describe('custom command discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-commands-'));
    resetCustomCommandCache();
    await mkdir(join(root, 'work', '.vendor', 'commands', 'git'), { recursive: true });
    await mkdir(join(root, 'work', '.clikcode', 'commands'), { recursive: true });
    await mkdir(join(root, 'home', '.clikcode', 'commands'), { recursive: true });
    await writeFile(join(root, 'work', '.vendor', 'commands', 'ship.md'), '---\ndescription: vendor ship\n---\nShip $ARGUMENTS');
    await writeFile(join(root, 'work', '.vendor', 'commands', 'git', 'commit.md'), 'Commit with message $1');
    await writeFile(join(root, 'work', '.clikcode', 'commands', 'ship.md'), 'shadowed');
    await writeFile(join(root, 'work', '.clikcode', 'commands', 'notes.md'), 'Write notes');
    await writeFile(join(root, 'home', '.clikcode', 'commands', 'global.md'), 'Global $ARGUMENTS');
    await writeFile(join(root, 'work', '.clikcode', 'commands', 'README.txt'), 'not a command');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const discover = () => discoverCustomCommands(
    { customCommandDirs: ['.vendor/commands'] }, { workspace: join(root, 'work'), home: join(root, 'home') },
  );

  it('reads harness directories, the workspace and the home directory, first definition winning', () => {
    const commands = discover();
    expect(commands.map((command) => `${command.name}:${command.source}`)).toEqual([
      'git:commit:harness', 'ship:harness', 'notes:clikcode', 'global:clikcode',
    ]);
    expect(commands.find((command) => command.name === 'ship')).toMatchObject({ description: 'vendor ship', body: 'Ship $ARGUMENTS' });
  });

  it('caches per directory until an mtime changes', async () => {
    const first = discover();
    expect(discover()[0]).toBe(first[0]);
    const path = join(root, 'work', '.clikcode', 'commands', 'notes.md');
    await writeFile(path, 'Write better notes');
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    expect(discover().find((command) => command.name === 'notes')?.body).toBe('Write better notes');
  });

  it('expands client-side unless the harness runs its own command natively', () => {
    const ship = discover().find((command) => command.name === 'ship')!;
    const global = discover().find((command) => command.name === 'global')!;
    expect(customCommandPrompt(ship, 'ABC-1', { nativeSlashPassthrough: false })).toBe('Ship ABC-1');
    expect(customCommandPrompt(ship, 'ABC-1', { nativeSlashPassthrough: true })).toBe('/ship ABC-1');
    // A ClikCode-level command is unknown to the vendor: always expanded.
    expect(customCommandPrompt(global, 'x', { nativeSlashPassthrough: true })).toBe('Global x');
  });

  it('a missing directory has no commands', () => {
    expect(discoverCustomCommands({ customCommandDirs: ['nope'] }, { workspace: join(root, 'void'), home: join(root, 'void') })).toEqual([]);
  });
});
