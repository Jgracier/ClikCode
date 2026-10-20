/** Drafts an editor's shared bridge shows (several chats in one process):
 * one chat's new chat or write never drops another chat's draft. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConversation } from './attach.js';
import { ephemeralSession, unpinDraft } from './ephemeral.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

describe('pinned drafts', () => {
  it('survive a sibling\'s new chat and a write from a working copy read before them; unpinned, they go as before', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'draft-pin-'));
    const stale = await readState({ transcripts: [] });
    const first = await openConversation(workspace, 'new', undefined, { pin: true });
    const second = await openConversation(workspace, 'new', undefined, { pin: true });
    expect(ephemeralSession(first)).toBeDefined();
    expect(ephemeralSession(second)).toBeDefined();
    // Another chat writes what it read before either draft existed.
    await writeState(stale);
    expect(ephemeralSession(first)).toBeDefined();
    expect(ephemeralSession(second)).toBeDefined();
    unpinDraft(first);
    unpinDraft(second);
    const third = await openConversation(workspace, 'new');
    expect(ephemeralSession(first)).toBeUndefined();
    expect(ephemeralSession(second)).toBeUndefined();
    expect(ephemeralSession(third)).toBeDefined();
  });
});
