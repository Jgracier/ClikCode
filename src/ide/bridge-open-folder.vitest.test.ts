/** An editor on another machine names a folder of its own (or none) for a new chat. This
 * machine opens the chat in its home instead: a vendor started in a missing folder fails as
 * `spawn <binary> ENOENT`, which reads as a harness that is not installed. */
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';

const opened: string[] = [];
vi.mock('../session/attach.js', async (original) => ({
  ...(await original<typeof import('../session/attach.js')>()),
  openConversation: async (workspace: string) => { opened.push(workspace); return 's1'; },
  resolveSessionModel: async () => undefined,
}));
const { IdeBridge } = await import('./bridge.js');

describe('a chat opened from an editor on another machine', () => {
  const open = async (workspace: string): Promise<string> => {
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const inner = bridge as unknown as { open(workspace: string, mode: 'new'): Promise<void>; current(id: string): Promise<unknown>; switchTo(id: string): Promise<void>; synchronizeOpened(id: string): Promise<void> };
    inner.current = async () => ({ session: { id: 's1', route: 'gateway' } });
    inner.switchTo = async () => undefined;
    inner.synchronizeOpened = async () => undefined;
    await inner.open(workspace, 'new');
    return opened.at(-1)!;
  };

  it('opens in this machine\'s home when the folder is not here, or none was named', async () => {
    expect(await open('/home/someone-on-another-machine')).toBe(homedir());
    expect(await open('')).toBe(homedir());
  });

  it('keeps a folder this machine has', async () => {
    expect(await open(tmpdir())).toBe(tmpdir());
  });
});
