import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { dispatchLine, type SlashHost } from './dispatch';
import { readState } from '../../session/state/read';
import { writeState } from '../../session/state/write';
import type { HarnessSession, HarnessState } from '../../session/model';

const chat = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: null, effort: 'medium',
  permissionMode: 'ask', accountFailover: 'never', messages: [{ role: 'user', content: 'hi' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...overrides,
});
const stateWith = (...sessions: HarnessSession[]): HarnessState => ({
  sessions, accounts: [], invocations: [], providerSettings: {},
  globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
} as unknown as HarnessState);

/** A screen that records what it was asked to show, and can pick nothing. */
function recordingHost(overrides: Partial<SlashHost> = {}): SlashHost & { panels: string[][] } {
  const panels: string[][] = [];
  return {
    panels,
    config: {} as Conf,
    prompter: { question: async () => '', close: () => undefined },
    canPick: false,
    panel: (kind, title) => { panels.push([kind, title]); },
    withBusy: (_label, work) => work(),
    ask: async () => '',
    redraw: async () => undefined,
    runTurn: async () => undefined,
    openConversationPicker: async (id) => ({ id }),
    editFile: async () => undefined,
    ...overrides,
  };
}

describe('one dispatch for every client', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let workspace: string;
  beforeEach(async () => {
    process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-dispatch-'));
    workspace = mkdtempSync(join(tmpdir(), 'cc-dispatch-ws-'));
    await writeState(stateWith(chat({ workspace })));
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('sends a message as a turn, echoed', async () => {
    expect(await dispatchLine(recordingHost(), 's1', 'explain this')).toEqual({ prompt: 'explain this', echo: true });
  });

  it('attaches a file named on its own, and tells the host', async () => {
    writeFileSync(join(workspace, 'shot.png'), 'png');
    const attached = vi.fn();
    const outcome = await dispatchLine(recordingHost({ attached }), 's1', join(workspace, 'shot.png'));
    expect(outcome.notice).toMatch(/^Attached .*shot\.png for the next request$/);
    expect(attached).toHaveBeenCalledWith([join(workspace, 'shot.png')]);
    expect((await readState()).sessions[0]?.attachments).toEqual([join(workspace, 'shot.png')]);
  });

  it('turns /review into a turn that is not shown as typed', async () => {
    expect(await dispatchLine(recordingHost(), 's1', '/review')).toMatchObject({ echo: false });
  });

  it('puts /capabilities in the host\'s panel', async () => {
    await writeState(stateWith(chat({ workspace, nativeHarness: 'claude' })));
    const host = recordingHost();
    await dispatchLine(host, 's1', '/capabilities');
    expect(host.panels.map(([kind]) => kind)).toEqual(['capabilities']);
  });

  it('walks /search where the host can, and lists the results where it cannot', async () => {
    await writeState(stateWith(chat({ workspace, messages: [{ role: 'user', content: 'the okapi migration plan' }] })));
    const browseSearch = vi.fn(async () => ({ id: 's1' }));
    expect(await dispatchLine(recordingHost({ browseSearch }), 's1', '/search okapi migration')).toEqual({ id: 's1' });
    expect(browseSearch).toHaveBeenCalledWith('okapi migration');
    const listing = recordingHost();
    await dispatchLine(listing, 's1', '/search okapi migration');
    expect(listing.panels).toEqual([['search', '"okapi migration" — 1 conversation']]);
    expect(await dispatchLine(recordingHost(), 's1', '/search quokka')).toEqual({ notice: 'No conversation mentions "quokka"' });
    await expect(dispatchLine(recordingHost(), 's1', '/search')).rejects.toThrow('usage: /search <words>');
  });

  it('lets the host answer a command first', async () => {
    const outcome = await dispatchLine(recordingHost({ intercept: (route) => (route.entry.name === 'new' ? { notice: 'use the board' } : undefined) }), 's1', '/new');
    expect(outcome).toEqual({ notice: 'use the board' });
  });

  it('refuses an unknown command, and a command needing a provider where nothing can be picked', async () => {
    await expect(dispatchLine(recordingHost(), 's1', '/definitely-not-a-command')).rejects.toThrow();
    await expect(dispatchLine(recordingHost(), 's1', '/login')).rejects.toThrow(/Choose a provider/);
  });
});
