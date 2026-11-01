/** /restart: switching a window that is never idle to the newest installed build, and telling it that it is waiting for one. */
import { afterEach, describe, expect, it } from 'vitest';
import { registerBuildReplacer, replaceWindowBuild, shouldTellStale, STALE_BUILD_NOTICE_MS } from './build-replace.js';
import { SLASH_COMMANDS, TERMINAL_ONLY_COMMANDS } from '../../../tui/slash/registry.js';

afterEach(() => registerBuildReplacer(undefined));

describe('replacing this window with the newest build, on request', () => {
  it('leaves through the window\'s own way, and says nothing is to be done when it is already the newest', async () => {
    expect(replaceWindowBuild()).toBeUndefined();
    let left = 0;
    registerBuildReplacer(() => { left += 1; return Promise.resolve(); });
    await replaceWindowBuild();
    expect(left).toBe(1);
    registerBuildReplacer(() => undefined);
    expect(replaceWindowBuild()).toBeUndefined();
  });

  it('is the terminal\'s own command: an editor neither lists nor runs it', () => {
    expect(TERMINAL_ONLY_COMMANDS.has('restart')).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === 'restart')).toBe(true);
  });
});

describe('telling a window that never goes idle that a newer build waits', () => {
  const since = 1_000_000;
  it('is said once, after it has waited ten minutes, and not before or again', () => {
    expect(shouldTellStale(undefined, false, since + 99 * STALE_BUILD_NOTICE_MS)).toBe(false);
    expect(shouldTellStale(since, false, since + STALE_BUILD_NOTICE_MS - 1)).toBe(false);
    expect(shouldTellStale(since, false, since + STALE_BUILD_NOTICE_MS + 1)).toBe(true);
    expect(shouldTellStale(since, true, since + 5 * STALE_BUILD_NOTICE_MS)).toBe(false);
  });
});
