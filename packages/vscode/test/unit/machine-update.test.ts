/** A machine whose ClikCode is another commit than the one this editor runs
 * says so in the machine menus and on the composer's chip, and offers Update:
 * this computer always (as /update does), another machine when it needs one. */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveredMeta, machineChip, machineMeta, machineUpdateText, offersUpdate } from '../../src/webview/machine-text';
import { machineUpdateOf, updateFields, type ListedMachine } from '../../src/remote-directory';
import { runClikcodeUpdate } from '../../src/chat-machine';

vi.mock('vscode', () => ({}));

const listed = (overrides: Partial<ListedMachine> = {}): ListedMachine => ({ id: 'm1', name: 'prod', state: 'connected', chats: 3, needsYou: 0, ...overrides });

describe('a machine row', () => {
  it('reads current, state and chats, then its update state', () => {
    expect(machineMeta(listed(), 'm1')).toBe('current · connected · 3 chats');
    expect(machineMeta(listed({ needsUpdate: true }), 'local')).toBe('connected · 3 chats · needs update');
    expect(machineMeta(listed({ needsUpdate: true, updating: true }), 'local')).toBe('connected · 3 chats · updating ClikCode…');
    expect(machineMeta(listed({ needsUpdate: true, updateError: 'Building and installing: pnpm failed' }), 'local'))
      .toBe('connected · 3 chats · needs update · last update failed: Building and installing: pnpm failed');
    expect(machineUpdateText(listed({ needsUpdate: true, updateError: 'x'.repeat(200) }))!.length).toBeLessThan(140);
    expect(machineMeta(listed({ needsYou: 2 }), 'local')).toBe('connected · 3 chats · 2 need you');
  });

  it('offers Update on this computer always, and on another machine only when it needs one and answers', () => {
    expect(offersUpdate(listed({ id: 'local', state: 'local' }))).toBe(true);
    expect(offersUpdate(listed())).toBe(false);
    expect(offersUpdate(listed({ needsUpdate: true }))).toBe(true);
    expect(offersUpdate(listed({ needsUpdate: true, updateError: 'boom' }))).toBe(true);
    expect(offersUpdate(listed({ needsUpdate: true, updating: true }))).toBe(false);
    expect(offersUpdate(listed({ needsUpdate: true, state: 'offline' }))).toBe(false);
    expect(offersUpdate(listed({ id: 'tailscale:n1', state: 'available' }))).toBe(false);
  });

  it('says what choosing a machine from the tailnet does, or why it cannot be chosen', () => {
    expect(discoveredMeta(listed({ id: 'tailscale:n1', state: 'available' }))).toBe('Connect · install from GitHub main');
    expect(discoveredMeta(listed({ id: 'tailscale:n1', state: 'unavailable' }))).toBe('offline');
    expect(discoveredMeta(listed({ id: 'tailscale:n1', state: 'unsupported' }))).toBe('Windows is not supported yet');
  });

  it('carries a connection’s update state, and an old failure only while it still needs one', () => {
    expect(updateFields({ needsUpdate: false, updateError: 'old' })).toEqual({});
    expect(updateFields({ needsUpdate: true, updateError: 'boom', updating: false })).toEqual({ needsUpdate: true, updateError: 'boom' });
    expect(machineUpdateOf(undefined)).toBeUndefined();
    expect(machineUpdateOf({ needsUpdate: false })).toBeUndefined();
    expect(machineUpdateOf({ needsUpdate: true })).toEqual({ state: 'needs' });
    expect(machineUpdateOf({ needsUpdate: true, updating: true })).toEqual({ state: 'updating' });
    expect(machineUpdateOf({ needsUpdate: true, updateError: 'boom' })).toEqual({ state: 'failed', error: 'boom' });
  });
});

describe('the composer’s machine chip', () => {
  it('names the machine, and says when its ClikCode needs an update, offering it', () => {
    expect(machineChip({})).toEqual({ label: 'This machine', title: 'Machine: This machine', update: false });
    expect(machineChip({ machine: 'prod' })).toEqual({ label: 'prod', title: 'Machine: prod', update: false });
    expect(machineChip({ machine: 'prod', machineUpdate: { state: 'needs' } })).toEqual({ label: 'prod · needs update', title: 'Machine: prod (needs update)', update: true });
    expect(machineChip({ machine: 'prod', machineUpdate: { state: 'failed', error: 'Building and installing: pnpm failed' } }))
      .toEqual({ label: 'prod · update failed', title: 'Machine: prod (update failed: Building and installing: pnpm failed)', update: true });
    expect(machineChip({ machine: 'prod', machineUpdate: { state: 'updating' } })).toMatchObject({ label: 'prod · updating ClikCode…', update: false });
  });
});

describe('Update on this computer', () => {
  const entry = (body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'cc-vsc-update-')), 'index.js');
    writeFileSync(path, body);
    return path;
  };

  it('runs `clikcode update` of the ClikCode it runs, its lines as progress, its last line what it says', async () => {
    const lines: string[] = [];
    const said = await runClikcodeUpdate({ node: process.execPath, entry: entry("if (process.argv[2] !== 'update') process.exit(9); console.log('✓ 1/3 Getting ClikCode from GitHub'); console.log('This ClikCode on box is built from a developer checkout (/src); run `git pull && pnpm run install-local` in /src.');"), env: {} }, (line) => lines.push(line));
    expect(said).toMatch(/developer checkout.*git pull && pnpm run install-local/);
    expect(lines[0]).toBe('✓ 1/3 Getting ClikCode from GitHub');
  });

  it('rejects with the step that failed, and says when the ClikCode is too old to have the command', async () => {
    await expect(runClikcodeUpdate({ node: process.execPath, entry: entry("console.error('error: Building and installing: pnpm failed'); process.exit(1);"), env: {} }, () => undefined))
      .rejects.toThrow(/^Building and installing: pnpm failed$/);
    await expect(runClikcodeUpdate({ node: process.execPath, entry: entry("console.error(\"error: unknown command 'update'\"); process.exit(1);"), env: {} }, () => undefined))
      .rejects.toThrow(/older than `clikcode update`/);
  });
});
