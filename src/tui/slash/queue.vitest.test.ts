import { describe, expect, it } from 'vitest';
import { slashLineIsCommand } from './queue.js';
import { routeSlashInput, slashRouteAppliesDuringTurn, type SlashRouteContext } from './registry.js';

/** The half of the decision the composer cannot make: it takes the session,
 * the harness and the filesystem to tell a command from a path. */
const context: SlashRouteContext = {
  customCommands: ['ship'],
  pathExists: (path) => path === '/tmp' || path === '/etc/hosts',
};

describe('a slash line typed during a turn', () => {
  it('is ClikCode\'s to run', () => {
    expect(slashLineIsCommand('/model', context)).toBe(true);
    expect(slashLineIsCommand('/permissions plan', context)).toBe(true);
  });

  it('is ClikCode\'s for a custom command, so its prompt gets expanded', () => {
    // Queued as conversation this would reach the model as the word "/ship".
    expect(slashLineIsCommand('/ship', context)).toBe(true);
  });

  it('is ClikCode\'s even when the head is a typo, so the user sees why', () => {
    expect(slashLineIsCommand('/modl', context)).toBe(true);
  });

  it('is the model\'s when it is really conversation', () => {
    expect(slashLineIsCommand('also check the disk', context)).toBe(false);
    // The explicit verbatim escape: the harness answers this one.
    expect(slashLineIsCommand('//status', context)).toBe(false);
  });

  it('is conversation for a real path', () => {
    expect(slashLineIsCommand('/etc/hosts explain this', context)).toBe(false);
    expect(slashLineIsCommand('/tmp explain this', context)).toBe(false);
  });
});

/** When it applies: now, or at the turn boundary. Never with an announcement,
 * and never by interrupting the answer being written. */
describe('applying a command while a turn streams', () => {
  const applies = (line: string): boolean => slashRouteAppliesDuringTurn(routeSlashInput(line, context));

  it('applies an argument form that is a pure state write', () => {
    // Their handlers end in a `settings` payload, which in the TUI is a
    // status-line render and nothing else -- so this shows up where the model
    // and mode are already displayed, with no panel and no notice.
    expect(applies('/model sonnet')).toBe(true);
    expect(applies('/effort high')).toBe(true);
    expect(applies('/permissions bypass')).toBe(true);
    expect(applies('/account work')).toBe(true);
  });

  it('waits for the boundary when the command is a picker', () => {
    // A picker needs the screen the answer is being written on.
    expect(applies('/model')).toBe(false);
    expect(applies('/permissions')).toBe(false);
    expect(applies('/provider')).toBe(false);
  });

  it('applies a named provider while a turn streams', () => {
    const during = routeSlashInput('/codex', { ...context, harnessCommands: ['codex'] });
    expect(slashRouteAppliesDuringTurn(during)).toBe(true);
    expect(applies('/sandbox off')).toBe(true);
    expect(applies('/fast on')).toBe(true);
  });

  it('waits for the boundary for anything that shows something', () => {
    expect(applies('/usage')).toBe(false);
    expect(applies('/export /tmp/out.md')).toBe(false);
    expect(applies('/new')).toBe(false);
    expect(applies('/compact focus')).toBe(false);
  });

  it('never applies conversation', () => {
    expect(applies('also check the disk')).toBe(false);
    expect(applies('//status')).toBe(false);
  });
});

describe('/restart typed while a turn streams', () => {
  it('switches the window at once, and is not left queued behind the turn it is trying to get past', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeState } = await import('../../session/state/write.js');
    const { readState } = await import('../../session/state/read.js');
    const { commandDuringTurn } = await import('./queue.js');
    const { registerBuildReplacer } = await import('../../commands/ai/interactive/build-replace.js');
    const root = await mkdtemp(join(tmpdir(), 'cc-restart-'));
    const before = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = root;
    try {
      const now = new Date().toISOString();
      await writeState({
        sessions: [{ id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: null, model: null, effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', name: 'Chat', messages: [] } as never],
        accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
      } as never);
      let left = 0;
      registerBuildReplacer(() => { left += 1; return new Promise(() => undefined); });
      const result = await commandDuringTurn('s1', '/restart');
      expect(left).toBe(1);
      expect(result).toMatchObject({ disposition: 'command', commandOutcome: 'applied' });
      const session = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1');
      expect(session?.queuedTurns ?? []).toEqual([]);
    } finally {
      registerBuildReplacer(undefined);
      if (before === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = before;
      await rm(root, { recursive: true, force: true });
    }
  });
});
