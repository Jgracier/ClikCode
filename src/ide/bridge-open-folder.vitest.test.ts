/** An editor on another machine names a folder of its own (or none) for a chat. Which folder
 * the chat is in is session/attach.ts's rule (attach.vitest.test.ts); the bridge passes what the
 * editor named as it is and shows what the rule says as a warning notice. */
import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import type { IdeEvent } from './protocol.js';

const opened: string[] = [];
vi.mock('../session/attach.js', async (original) => ({
  ...(await original<typeof import('../session/attach.js')>()),
  openConversation: async (workspace: string, _mode: string, _ref: string | undefined, options: { notice?: (message: string) => void }) => {
    opened.push(workspace);
    if (workspace) options.notice?.(`The folder ${workspace} does not exist on here; this chat opens in /home/remote.`);
    return 's1';
  },
  resolveSessionModel: async () => undefined,
}));
const { IdeBridge } = await import('./bridge.js');

describe('a chat opened from an editor on another machine', () => {
  const open = async (workspace: string): Promise<IdeEvent[]> => {
    const sent: IdeEvent[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (event: IdeEvent) => { sent.push(event); } });
    const inner = bridge as unknown as { open(workspace: string, mode: 'new'): Promise<void>; current(id: string): Promise<unknown>; switchTo(id: string): Promise<void>; synchronizeOpened(id: string): Promise<void> };
    inner.current = async () => ({ session: { id: 's1', route: 'gateway' } });
    inner.switchTo = async () => undefined;
    inner.synchronizeOpened = async () => undefined;
    await inner.open(workspace, 'new');
    return sent;
  };

  it('shows the folder rule\'s notice as a warning', async () => {
    expect(await open('/home/someone-on-another-machine')).toContainEqual({
      type: 'notice', level: 'warning', message: 'The folder /home/someone-on-another-machine does not exist on here; this chat opens in /home/remote.',
    });
    expect(opened.at(-1)).toBe('/home/someone-on-another-machine');
  });

  it('says nothing when the rule has nothing to say', async () => {
    expect((await open('')).filter((event) => event.type === 'notice')).toEqual([]);
  });
});
