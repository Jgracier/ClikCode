import { describe, expect, it } from 'vitest';
import { slashLineIsCommand } from './queue.js';
import type { SlashRouteContext } from './registry.js';

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
