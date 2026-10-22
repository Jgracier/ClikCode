/** A machine Tailscale found is added from any machine list (the chip's menu,
 * the history menu's Machines): which user to log in as is asked before
 * anything connects -- Tailscale gives the machine, not the account on it --
 * with ssh's default for it filled in; then ClikCode is installed there as
 * that user. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  asked: [] as Array<{ title?: string; value?: string }>,
  answer: 'root' as string | undefined,
  installs: [] as string[],
  saved: [] as Array<{ sshTarget: string; name: string }>,
}));

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose: () => undefined }); fire(): void {} dispose(): void {} },
  Disposable: class { constructor(private readonly done: () => void) {} dispose(): void { this.done(); } },
  ProgressLocation: { Notification: 15 },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }), workspaceFolders: [] },
  window: {
    showInputBox: async (options: { title?: string; value?: string }) => { world.asked.push({ title: options.title, value: options.value }); return world.answer; },
    withProgress: async (_options: unknown, work: (progress: { report(): void }) => Promise<unknown>) => work({ report: () => undefined }),
    showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
  },
  env: { clipboard: { writeText: async () => undefined } },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));
vi.mock('../../src/ui', () => ({ DiffDocuments: class {}, openSignInLink: () => undefined, runInTerminal: async () => undefined, fileNameIn: () => undefined }));
vi.mock('../../src/remote-directory', () => ({
  remoteDirectory: { refresh: async () => undefined, localCommit: async () => undefined, watch: () => () => undefined, hold: () => () => undefined },
  machineUpdateOf: () => undefined,
}));
vi.mock('../../../../src/remote/tailscale', () => ({
  readTailscaleStatus: async () => ({ status: {} }),
  discoverMachines: () => [{ nodeId: 'nBox', name: 'devbox', dnsName: 'devbox.tail-fake.ts.net', hostName: 'devbox', os: 'linux', online: true }],
}));
vi.mock('../../../../src/remote/ssh', () => ({ defaultLoginUser: async () => 'me' }));
vi.mock('../../../../src/remote/install', () => ({
  installOnMachine: async (target: string) => { world.installs.push(target); return { ok: true, info: { version: '1.0.0', installationId: 'install-1' } }; },
}));
vi.mock('../../../../src/remote/machines', () => ({
  readMachines: async () => [],
  newMachineRecord: (fields: Record<string, unknown>) => ({ id: 'new-1', ...fields }),
  updateMachines: async (change: (list: unknown[]) => Array<{ sshTarget: string; name: string }>) => { world.saved = change([]); return world.saved; },
  updateMachine: async () => undefined, forgetMachine: async () => [],
}));

import { ClikCodeController } from '../../src/controller';

const controllers: ClikCodeController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); world.asked = []; world.installs = []; world.saved = []; world.answer = 'root'; });

const addFromTailnet = (): Promise<string> => {
  const host = { log: { appendLine: () => undefined }, diffs: {}, openInTab: async () => undefined, reveal: async () => undefined, chats: () => [] };
  const controller = new ClikCodeController(host as never, undefined, 'chat');
  controllers.push(controller);
  return (controller as unknown as { connectDiscovered(id: string): Promise<string> }).connectDiscovered('tailscale:nBox');
};

describe('adding a machine from the tailnet', () => {
  it('asks which user first, with ssh’s default filled in, then installs and saves it as that user', async () => {
    expect(await addFromTailnet()).toBe('new-1');
    expect(world.asked).toEqual([{ title: 'Log in to devbox as', value: 'me' }]);
    expect(world.installs).toEqual(['root@devbox.tail-fake.ts.net']);
    expect(world.saved).toEqual([expect.objectContaining({ name: 'devbox', sshTarget: 'root@devbox.tail-fake.ts.net', tailscale: { nodeId: 'nBox', dnsName: 'devbox.tail-fake.ts.net' } })]);
  });

  it('adds nothing when the question is dismissed', async () => {
    world.answer = undefined;
    await expect(addFromTailnet()).rejects.toThrow(/cancelled/);
    expect(world.installs).toEqual([]);
    expect(world.saved).toEqual([]);
  });
});
