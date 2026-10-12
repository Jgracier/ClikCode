import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, compactionThreshold, environmentNote, needsEnvironmentNote, staticInstructions, toolOutputCap } from './context.js';
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

describe('how answers are laid out', () => {
  it('asks every profile for Markdown shaped like a vendor CLI\'s answers', () => {
    for (const full of [true, false]) {
      const prompt = staticInstructions(full);
      expect(prompt).toContain('# Formatting answers');
      expect(prompt).toMatch(/fenced code blocks with a language tag/);
      expect(prompt).toMatch(/`src\/app\.ts:42`/);
    }
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

describe('a conversation run as a Gateway agent', () => {
  it('carries the agent\'s instructions after ClikCode\'s own, and none without one', async () => {
    const input = { cwd: '/repo', userConfigDir: '/nonexistent-config', git: fakeGit({ branch: 'main', status: '' }) };
    const plain = await buildSystemPrompt(input);
    const asAgent = await buildSystemPrompt({ ...input, agentInstructions: 'You are @silas.\n\nWatch the platform.' });
    expect(plain).not.toContain('# Agent');
    expect(asAgent).toContain('# Agent');
    expect(asAgent).toContain('Watch the platform.');
    // ClikCode's own instructions come first: the agent adds to the harness, it does not replace it.
    expect(asAgent.indexOf(staticInstructions(true).slice(0, 40))).toBeLessThan(asAgent.indexOf('# Agent'));
  });
});

describe('sections that make the model restrained about scope and risk', () => {
  it('puts each in the assembled prompt of every profile', async () => {
    for (const full of [true, false]) {
      const prompt = await buildSystemPrompt({ cwd: '/repo', userConfigDir: '/nonexistent-config', git: fakeGit({ branch: 'main', status: '' }), toolUsageGuidance: full });
      expect(prompt).toContain('# Doing tasks');
      expect(prompt).toMatch(/exploratory question/i);
      expect(prompt).toContain('# Risky actions');
      expect(prompt).toMatch(/approval once/i);
      expect(prompt).toContain('# Git');
      expect(prompt).toMatch(/--no-verify/);
      expect(prompt).toMatch(/only when asked/i);
    }
  });
});

describe('instruction files', () => {
  async function workspace(): Promise<{ root: string; home: string; cwd: string; prompt: () => Promise<string> }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-memory-')));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'repo');
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    return { root, home, cwd, prompt: () => buildSystemPrompt({ cwd, userConfigDir: path.join(root, 'state'), homeDir: home, git: fakeGit({ branch: 'main', status: '' }) }) };
  }

  it('inlines @imports relative to the file, skips code spans, missing files and protected paths', async () => {
    const w = await workspace();
    await fs.mkdir(path.join(w.cwd, 'docs'), { recursive: true });
    await fs.writeFile(path.join(w.cwd, 'docs', 'style.md'), 'STYLE-RULES see @deeper.md');
    await fs.writeFile(path.join(w.cwd, 'docs', 'deeper.md'), 'DEEP-RULES');
    await fs.mkdir(path.join(w.home, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(w.home, '.ssh', 'id'), 'PRIVATE-KEY-BODY');
    await fs.writeFile(path.join(w.cwd, 'CLAUDE.md'), 'Read @docs/style.md and @missing.md and `@docs/style.md` and @~/.ssh/id\n');
    const prompt = await w.prompt();
    expect(prompt).toContain('STYLE-RULES');
    expect(prompt).toContain('DEEP-RULES');
    expect(prompt).not.toContain('PRIVATE-KEY-BODY');
    expect(prompt.match(/STYLE-RULES/g)).toHaveLength(1);
    await fs.rm(w.root, { recursive: true, force: true });
  });

  it('adds CLAUDE.local.md beside the project file and the user\'s ~/.claude/CLAUDE.md first', async () => {
    const w = await workspace();
    await fs.writeFile(path.join(w.home, '.claude', 'CLAUDE.md'), 'USER-GLOBAL');
    await fs.writeFile(path.join(w.cwd, 'AGENTS.md'), 'PROJECT-AGENTS');
    await fs.writeFile(path.join(w.cwd, 'CLAUDE.local.md'), 'MY-LOCAL');
    const prompt = await w.prompt();
    expect(prompt.indexOf('USER-GLOBAL')).toBeGreaterThan(-1);
    expect(prompt.indexOf('USER-GLOBAL')).toBeLessThan(prompt.indexOf('PROJECT-AGENTS'));
    expect(prompt.indexOf('PROJECT-AGENTS')).toBeLessThan(prompt.indexOf('MY-LOCAL'));
    await fs.rm(w.root, { recursive: true, force: true });
  });

  it('says which instruction files were left out once the budget is spent, and names no file that does not exist', async () => {
    const w = await workspace();
    // The user's own file alone spends the whole 32 KB budget; the project's files come after it.
    await fs.writeFile(path.join(w.home, '.claude', 'CLAUDE.md'), `${'rule of the house\n'.repeat(3000)}`);
    await fs.writeFile(path.join(w.cwd, 'AGENTS.md'), 'PROJECT-AGENTS-BODY');
    await fs.writeFile(path.join(w.cwd, 'CLAUDE.local.md'), 'LOCAL-BODY');
    const prompt = await w.prompt();
    expect(prompt).toContain('[truncated]');
    expect(prompt).not.toContain('PROJECT-AGENTS-BODY');
    expect(prompt).toMatch(/2 more instruction files were not loaded because the 32 KB instruction budget is used up: .*AGENTS\.md.*CLAUDE\.local\.md/);
    // CLAUDE.md and .claude/CLAUDE.md do not exist here: they are not reported.
    expect(prompt.match(/not loaded because[^\n]*/)?.[0]).not.toMatch(/\.claude\/CLAUDE\.md|[^.]CLAUDE\.md/);
    await fs.rm(w.root, { recursive: true, force: true });
  });

  it('says nothing about omissions when everything fits', async () => {
    const w = await workspace();
    await fs.writeFile(path.join(w.cwd, 'AGENTS.md'), 'SMALL');
    expect(await w.prompt()).not.toMatch(/not loaded because/);
    await fs.rm(w.root, { recursive: true, force: true });
  });
});
