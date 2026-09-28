/** ELECTRON_RUN_AS_NODE, set to run ClikCode on VS Code's Electron, must not
 * reach the vendor CLIs and shells it starts: an Electron app launched from
 * one (`code --wait` as $EDITOR) would come up as a bare Node. ClikCode
 * starting itself again still needs it. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvironment } from './electron-env.js';
import { spawnPortable } from '../harness/transport/spawn.js';

const run = (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
  const child = spawnPortable(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.on('error', reject);
  child.on('close', () => resolve(output.trim()));
});

describe('ELECTRON_RUN_AS_NODE', () => {
  it('is left out of a child\'s environment', () => {
    expect(childEnvironment('claude', { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, '/opt/code/code')).toEqual({ PATH: '/bin' });
  });

  it('is kept for ClikCode starting its own executable again', () => {
    const environment = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' };
    expect(childEnvironment('/opt/code/code', environment, '/opt/code/code')).toBe(environment);
  });

  it('leaves an environment without it untouched', () => {
    const environment = { PATH: '/bin' };
    expect(childEnvironment('claude', environment, '/opt/code/code')).toBe(environment);
  });

  it.skipIf(process.platform === 'win32')('does not reach a shell or vendor CLI spawned by ClikCode', async () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    expect(await run('sh', ['-c', 'echo "${ELECTRON_RUN_AS_NODE:-unset}"'], env)).toBe('unset');
    // Inherited rather than passed: the same.
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      expect(await run('sh', ['-c', 'echo "${ELECTRON_RUN_AS_NODE:-unset}"'], process.env)).toBe('unset');
      expect(await new Promise<string>((resolve) => {
        const child = spawnPortable('sh', ['-c', 'echo "${ELECTRON_RUN_AS_NODE:-unset}"'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        child.on('close', () => resolve(output.trim()));
      })).toBe('unset');
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  it('still reaches ClikCode\'s own re-spawn', async () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    expect(await run(process.execPath, ['-e', 'console.log(process.env.ELECTRON_RUN_AS_NODE ?? "unset")'], env)).toBe('1');
  });

  // VS Code's own Electron, as the extension's fallback runtime runs it.
  const electron = ['/usr/share/code/code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].find((path) => existsSync(path));
  const built = join(__dirname, '..', '..', 'dist', 'index.js');
  it.skipIf(!electron || !existsSync(built))('the built CLI starts on VS Code\'s Electron', () => {
    const output = execFileSync(electron!, [built, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000,
    });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
