import { describe, expect, it } from 'vitest';
import { bundledEntryFor, entryFor, pathCandidates, resolveEntry, resolveNode, resolveRuntime, versionAtLeast, type RuntimeHost } from '../../src/runtime';

function host(files: Record<string, string>, patch: Partial<RuntimeHost> = {}, links: Record<string, string> = {}): RuntimeHost {
  return {
    platform: 'linux', env: { PATH: '/usr/bin:/home/u/.local/bin' }, execPath: '/opt/code/code', hostNodeVersion: '24.15.0',
    exists: (path) => path in files || path in links,
    isFile: (path) => path in files || (path in links && links[path]! in files),
    realpath: (path) => links[path] ?? path,
    readHead: (path) => files[path] ?? '',
    nodeVersion: async (node) => (node.endsWith('node') ? '22.12.0' : undefined),
    ...patch,
  };
}

describe('runtime', () => {
  it('compares versions', () => {
    expect(versionAtLeast('22.12.0', '22.12.0')).toBe(true);
    expect(versionAtLeast('v24.1.0', '22.12.0')).toBe(true);
    expect(versionAtLeast('22.11.9', '22.12.0')).toBe(false);
    expect(versionAtLeast('20.18.1', '22.12.0')).toBe(false);
  });

  it('follows the clikcode symlink on PATH to dist/index.js', () => {
    const h = host({ '/p/dist/index.js': '#!/usr/bin/env node' }, {}, { '/home/u/.local/bin/clikcode': '/p/dist/index.js' });
    expect(resolveEntry('', h)).toBe('/p/dist/index.js');
  });

  it('finds the package behind a Windows npm shim', () => {
    const h = host({ 'C:\\npm/clikcode.cmd': '@echo off', 'C:\\npm/node_modules/clikcode/dist/index.js': '' }, { platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.CMD' } });
    expect(pathCandidates('clikcode', h)[0]).toMatch(/clikcode\.cmd$/);
    expect(resolveEntry('', h)).toBe('C:\\npm/node_modules/clikcode/dist/index.js');
  });

  it('accepts a node script without an extension and says how to install when nothing is found', () => {
    expect(entryFor('/x/clikcode', host({ '/x/clikcode': '#!/usr/bin/env node\n' }))).toBe('/x/clikcode');
    expect(() => resolveEntry('', host({}))).toThrow(/npm install -g/);
    expect(() => resolveEntry('/nope', host({}))).toThrow(/clikcode.path/);
  });

  it('runs the bundled ClikCode only when none is installed, so there is one build in play', async () => {
    const bundled = '/ext/bundled/clikcode/dist/index.js';
    const installed = host({ '/p/dist/index.js': '#!/usr/bin/env node', '/usr/bin/node': '' }, {}, { '/home/u/.local/bin/clikcode': '/p/dist/index.js' });
    // An installed ClikCode wins, whatever is bundled: the two would retire each other's workers.
    expect(resolveEntry('', installed, bundled)).toBe('/p/dist/index.js');
    await expect(resolveRuntime({}, installed, bundled)).resolves.toMatchObject({ entry: '/p/dist/index.js', entrySource: 'path' });
    // None installed: the bundled one makes the extension work on its own.
    const bare = host({ '/usr/bin/node': '' });
    expect(resolveEntry('', bare, bundled)).toBe(bundled);
    await expect(resolveRuntime({}, bare, bundled)).resolves.toMatchObject({ entry: bundled, entrySource: 'bundled' });
    // An explicit clikcode.path is the user's word and is never second-guessed.
    expect(() => resolveEntry('/nope', bare, bundled)).toThrow(/clikcode.path/);
    // Without a bundled copy (a development checkout) nothing changes.
    expect(() => resolveEntry('', bare)).toThrow(/npm install -g/);
  });

  it('finds the bundled entry inside the extension, if this build has one', () => {
    expect(bundledEntryFor('/ext', { isFile: (path) => path === '/ext/bundled/clikcode/dist/index.js' })).toBe('/ext/bundled/clikcode/dist/index.js');
    expect(bundledEntryFor('/ext', { isFile: () => false })).toBeUndefined();
  });

  it('prefers the setting, then node on PATH, then VS Code as Node', async () => {
    await expect(resolveNode('/custom/node', host({}))).resolves.toMatchObject({ node: '/custom/node', nodeSource: 'setting' });
    await expect(resolveNode('', host({ '/usr/bin/node': '' }))).resolves.toMatchObject({ node: '/usr/bin/node', nodeSource: 'path', env: {} });
    await expect(resolveNode('', host({ '/usr/bin/node': '' }, { nodeVersion: async () => '20.0.0' })))
      .resolves.toEqual({ node: '/opt/code/code', env: { ELECTRON_RUN_AS_NODE: '1' }, nodeSource: 'vscode' });
    await expect(resolveNode('', host({}, { hostNodeVersion: '20.18.0' }))).rejects.toThrow(/22\.12/);
    await expect(resolveNode('/old/node', host({}, { nodeVersion: async () => '18.0.0' }))).rejects.toThrow(/18\.0\.0/);
  });
});
