import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const capture = vi.fn(async () => '  --effort <level>   Effort level (low, medium, high)');
vi.mock('../transport/native/command.js', () => ({ captureNativeHarnessOutput: capture }));
vi.mock('../transport/native/version-memo.js', () => ({ harnessBinaryIdentity: async () => '/bin/fake:1:2' }));

const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'clikcode-effort-memo-'));
process.env.CLIKCODE_HOME = home;
afterAll(async () => { delete process.env.CLIKCODE_HOME; await rm(home, { recursive: true, force: true }); });

describe('effort levels from --help', () => {
  it('are read once per binary, not once per run', async () => {
    const harness = { command: 'fake', binary: 'fake', effortArgvPrefix: ['--effort'], effortValues: [] } as never;
    const first = await import('./effort-choices.js');
    expect((await first.effortChoicesFor(harness)).values).toEqual(['low', 'medium', 'high']);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(home, 'cache', 'effort-help.json'), 'utf8')).harnesses.fake.identity).toBe('/bin/fake:1:2');
    // A new process: nothing in memory, the memo on disk answers.
    vi.resetModules();
    const second = await import('./effort-choices.js');
    expect((await second.effortChoicesFor(harness)).values).toEqual(['low', 'medium', 'high']);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
