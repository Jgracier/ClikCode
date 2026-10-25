/** /machine is near the top of the / menu, under /model and /hosted, and /remote
 * is gone: what it did is /machine's. */
import { describe, expect, it } from 'vitest';
import { resolveSlashCommand, SLASH_COMMANDS, SLASH_PALETTE_PINNED } from './registry.js';

describe('the / menu', () => {
  it('pins /machine right after /model and /hosted', () => {
    expect(SLASH_PALETTE_PINNED.indexOf('hosted')).toBe(SLASH_PALETTE_PINNED.indexOf('model') + 1);
    expect(SLASH_PALETTE_PINNED.indexOf('machine')).toBe(SLASH_PALETTE_PINNED.indexOf('hosted') + 1);
  });

  it('has no /remote', () => {
    expect(resolveSlashCommand('remote')).toBeUndefined();
    expect(SLASH_COMMANDS.some((entry) => entry.name === 'remote')).toBe(false);
  });
});
