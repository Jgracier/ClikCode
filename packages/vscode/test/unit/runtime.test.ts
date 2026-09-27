import { describe, expect, it } from 'vitest';
import { entryFor, pathCandidates, resolveEntry, resolveNode, versionAtLeast, type RuntimeHost } from '../../src/runtime';

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

  it('prefers the setting, then node on PATH, then VS Code as Node', async () => {
    await expect(resolveNode('/custom/node', host({}))).resolves.toMatchObject({ node: '/custom/node', nodeSource: 'setting' });
    await expect(resolveNode('', host({ '/usr/bin/node': '' }))).resolves.toMatchObject({ node: '/usr/bin/node', nodeSource: 'path', env: {} });
    await expect(resolveNode('', host({ '/usr/bin/node': '' }, { nodeVersion: async () => '20.0.0' })))
      .resolves.toEqual({ node: '/opt/code/code', env: { ELECTRON_RUN_AS_NODE: '1' }, nodeSource: 'vscode' });
    await expect(resolveNode('', host({}, { hostNodeVersion: '20.18.0' }))).rejects.toThrow(/22\.12/);
    await expect(resolveNode('/old/node', host({}, { nodeVersion: async () => '18.0.0' }))).rejects.toThrow(/18\.0\.0/);
  });
});
