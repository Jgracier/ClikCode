import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, compactionThreshold, environmentNote, needsEnvironmentNote, toolOutputCap } from './context.js';
import type { ConversationItem } from './model-client.js';

/** A fake git whose answers can change between calls, as a real repo's do. */
function fakeGit(state: { branch: string; status: string }) {
  return async (args: readonly string[]): Promise<string | undefined> => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('--abbrev-ref')) return `${state.branch}\n`;
    if (args[0] === 'status') return state.status;
    return undefined;
  };
}

describe('system prompt stability', () => {
  it('is byte-identical when the date, branch and git status change', async () => {
    // Anything volatile in the system prompt re-bills (or, locally, re-reads)
    // the whole conversation on every turn. It belongs in environmentNote.
    const state = { branch: 'main', status: '' };
    const input = { cwd: '/repo', userConfigDir: '/nonexistent-config', git: fakeGit(state) };
    const before = await buildSystemPrompt(input);
    state.branch = 'feature';
    state.status = ' M src/a.ts\n?? new.txt\n';
    const after = await buildSystemPrompt(input);
    expect(after).toBe(before);
    expect(before).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(before).toContain('Git repository: /repo');
  });
});

describe('environment note', () => {
  it('reports the date, branch and changed paths', async () => {
    const note = await environmentNote({ cwd: '/repo', now: new Date('2026-09-27T10:00:00Z'), git: fakeGit({ branch: 'main', status: ' M a.ts\n' }) });
    expect(note).toBe('<environment>\nDate: 2026-09-27\nGit branch: main\nGit status: 1 changed path(s)\n M a.ts\n</environment>');
  });

  it('is needed once per conversation and again on a new day', () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const user = (text: string): ConversationItem => ({ type: 'text', role: 'user', text });
    expect(needsEnvironmentNote([], now)).toBe(true);
    const today = [user('<environment>\nDate: 2026-09-27\n</environment>\n\nfix it'), user('and this')];
    expect(needsEnvironmentNote(today, now)).toBe(false);
    expect(needsEnvironmentNote([user('<environment>\nDate: 2026-09-26\n</environment>\n\nfix it')], now)).toBe(true);
    // Compaction summarized the note away: say it again.
    expect(needsEnvironmentNote([{ type: 'summary', text: 'earlier work' }, user('go on')], now)).toBe(true);
  });
});

describe('window-sized limits', () => {
  it('compacts at 80% of a large window but keeps ~8k tokens of headroom in a small one', () => {
    expect(compactionThreshold(200_000)).toBe(160_000);
    expect(compactionThreshold(undefined)).toBe(102_400);
    expect(compactionThreshold(32_768)).toBe(32_768 - 8_192);
    // Tiny windows: 30% headroom rather than nothing left at all.
    expect(compactionThreshold(8_192)).toBe(Math.floor(8_192 * 0.7));
  });

  it('caps one tool result at a tenth of a small window, never above 30 KB', () => {
    expect(toolOutputCap(undefined)).toBe(30 * 1024);
    expect(toolOutputCap(1_000_000)).toBe(30 * 1024);
    expect(toolOutputCap(32_768)).toBe(Math.floor(32_768 * 0.4));
    expect(toolOutputCap(4_096)).toBe(8 * 1024);
  });
});
