import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { binaryOnPath, executableNames } from './native-harness';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('portable harness executable discovery', () => {
  it('uses PATHEXT for native Windows and leaves Unix commands unchanged', () => {
    expect(executableNames('codex', 'win32', '.EXE;.CMD')).toEqual(['codex', 'codex.EXE', 'codex.CMD']);
    expect(executableNames('codex.cmd', 'win32', '.EXE;.CMD')).toEqual(['codex.cmd']);
    expect(executableNames('codex', 'darwin')).toEqual(['codex']);
    expect(executableNames('codex', 'linux')).toEqual(['codex']);
  });

  it('finds quoted Windows PATH entries and npm .cmd shims', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-path-'));
    temporary.push(directory);
    await writeFile(join(directory, 'codex.CMD'), '@echo off\r\n');
    await expect(binaryOnPath('codex', {
      platform: 'win32', path: `"${directory}";C:\\missing`, pathExt: '.EXE;.CMD',
    })).resolves.toBe(true);
  });
});
