import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';
import { accountSwitchNoteText, noteAccountSwitch, withAccountSwitchNote } from './account-switch-note.js';
import { stripResourceNotes } from './resource-note-text.js';
import { withMoveNote } from './resource-notes.js';

const spent = { from: 'personal', to: 'work', reason: 'quota-exhausted' };

describe('the note the agent gets when a turn moves to another account', () => {
  it('says who it left, why, and how much the new account has', () => {
    const note = accountSwitchNoteText(spent, '5h 100% left · Weekly 68% left');
    expect(note).toContain('personal ran out of usage');
    expect(note).toContain('continues on work');
    expect(note).toContain('work has 5h 100% left · Weekly 68% left');
    expect(note).toContain("a limit or error mentioned earlier was personal's");
  });

  it('names the failure when it was not a spent plan, and leaves usage out when none is known', () => {
    const note = accountSwitchNoteText({ from: 'a', to: 'b', reason: 'authentication-required' });
    expect(note).toMatch(/a failed \(.+\)/);
    expect(note).not.toContain('b has');
  });

  it('goes in front of the turn once, and a vendor\'s copy of the turn read back is stripped of it', () => {
    const once = withAccountSwitchNote('fix the bug', spent, '5h 90% left');
    expect(once.startsWith('<clikcode_resource_note>')).toBe(true);
    expect(withAccountSwitchNote(once, spent, '5h 90% left')).toBe(once);
    expect(stripResourceNotes(once)).toBe('fix the bug');
    // Beside a moved chat\'s note, both come off and the person\'s words are what is left.
    const both = withAccountSwitchNote(withMoveNote({ moveNote: 'This conversation moved from a to b.' }, 'fix the bug'), spent);
    expect(stripResourceNotes(both)).toBe('fix the bug');
  });

  it('adds nothing when the turn did not change account', () => {
    expect(withAccountSwitchNote('go', undefined, 'x')).toBe('go');
  });
});

describe('noteAccountSwitch for a vendor turn', () => {
  const account = (fields: Partial<AiHarnessAccount>): AiHarnessAccount => ({ id: 'acct-b', provider: 'anthropic', label: 'work', authKind: 'vendor-cli', status: 'ready', ...fields } as AiHarnessAccount);
  const state = { accounts: [] } as unknown as HarnessState;

  it('uses the new account\'s last reading, and is a no-op until the turn has switched', () => {
    const fresh = { at: new Date().toISOString(), label: '5h 100% left · Weekly 68% left' };
    const ctx = { session: { pendingTurn: undefined as { accountSwitch?: typeof spent } | undefined }, account: account({ usage: fresh } as never), state, turnText: 'go' };
    noteAccountSwitch(ctx as never);
    expect(ctx.turnText).toBe('go');
    ctx.session.pendingTurn = { accountSwitch: spent };
    noteAccountSwitch(ctx as never);
    expect(ctx.turnText).toContain('work has 5h 100% left · Weekly 68% left');
    const after = ctx.turnText;
    noteAccountSwitch(ctx as never);
    expect(ctx.turnText, 'a retry that kept its text does not get a second note').toBe(after);
    // A retry rebuilt from the request gets it again.
    ctx.turnText = 'go';
    noteAccountSwitch(ctx as never);
    expect(ctx.turnText).toBe(after);
  });

  it('leaves usage out for an account whose usage cannot be asked (an API key)', () => {
    const ctx = { session: { pendingTurn: { accountSwitch: { ...spent, to: 'key' } } }, account: account({ authKind: 'api-key', label: 'key' }), state, turnText: 'go' };
    noteAccountSwitch(ctx as never);
    expect(ctx.turnText).toContain('continues on key.');
    expect(ctx.turnText).not.toContain('key has');
  });
});
