/** The editor's panel runs a worker's sign-in as a terminal window does:
 * only for the conversation it shows, taken down when the request closes or
 * the panel moves on, and never answered once taken down. */
import { describe, expect, it, vi } from 'vitest';

const login = vi.hoisted(() => ({ finish: [] as Array<() => void> }));
vi.mock('../harness/transport/native/login.js', async (original) => ({
  ...(await original<typeof import('../harness/transport/native/login.js')>()),
  loginNativeHarness: () => new Promise<void>((resolve) => { login.finish.push(resolve); }),
}));

import { WorkerLink } from './bridge-worker.js';
import { IdePrompter } from './prompter.js';
import type { BridgeHost } from './bridge-host.js';
import type { ClientCommand, WorkerEvent } from '../worker/protocol.js';
import type { WorkerClient } from '../worker/client.js';

const request = (id: string): WorkerEvent => ({ type: 'sign-in-request', id, command: 'claude', argv: ['auth', 'login'], environment: {}, name: 'Claude Code' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const prompter = new IdePrompter({ send: () => undefined });
  const host = { sessionId: 's1', prompter, channel: { send: () => undefined }, closed: false, shown: true } as unknown as BridgeHost;
  const link = new WorkerLink(host);
  const sent: ClientCommand[] = [];
  const client = { send: (command: ClientCommand) => { sent.push(command); }, close: () => undefined } as unknown as WorkerClient;
  return { link, client, sent, prompter };
}

describe('the editor panel and a worker\'s sign-in', () => {
  it('claims and runs only the sign-ins of the conversation it shows', async () => {
    const { link, client, sent, prompter } = setup();
    link.onWorkerEvent('s2', client, { type: 'sign-in-pending', id: 'other', name: 'Claude Code' });
    link.onWorkerEvent('s2', client, request('other'));
    link.onWorkerEvent('s1', client, { type: 'sign-in-pending', id: 'mine', name: 'Claude Code' });
    expect(sent).toEqual([{ type: 'sign-in-release', id: 'other' }, { type: 'sign-in-claim', id: 'mine' }]);
    link.onWorkerEvent('s1', client, request('mine'));
    link.onWorkerEvent('s1', client, request('mine'));
    await settle();
    expect(prompter.openCount, 'one card, however often it is asked').toBe(1);
    expect(login.finish).toHaveLength(1);
    login.finish.shift()!();
    await settle();
    expect(sent.at(-1)).toEqual({ type: 'sign-in-response', id: 'mine' });
  });

  it('takes the sign-in down, unanswered, when the request closes elsewhere', async () => {
    const { link, client, sent, prompter } = setup();
    link.onWorkerEvent('s1', client, request('a'));
    await settle();
    link.onWorkerEvent('s1', client, { type: 'request-closed', id: 'a' });
    expect(prompter.openCount).toBe(0);
    login.finish.shift()!();
    await settle();
    expect(sent.filter((command) => command.type === 'sign-in-response')).toEqual([]);
  });

  it('takes its sign-ins down when it leaves the conversation', async () => {
    const { link, client, sent, prompter } = setup();
    link.worker = { sessionId: 's1', client };
    link.onWorkerEvent('s1', client, request('a'));
    await settle();
    link.detach();
    expect(prompter.openCount).toBe(0);
    login.finish.shift()!();
    await settle();
    expect(sent.filter((command) => command.type === 'sign-in-response')).toEqual([]);
  });
});
