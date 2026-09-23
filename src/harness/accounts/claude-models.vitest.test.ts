import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { claudeModelAliases, claudeModelLabel, claudeModelTable, parseClaudeModelTable } from './claude-models.js';

/** The shapes, copied from a real Claude Code 2.1.280 bundle. */
const BUNDLE = [
  'junk,max:1.7},image_limits:{maxWidth:2000},advisor_rank:4},',
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026",provider_ids:{}},',
  '{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",knowledge_cutoff:"June 2026",provider_ids:{}},',
  '{id:"claude-sonnet-5",family:"sonnet",display_name:"Sonnet 5",provider_ids:{}},',
  '{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",provider_ids:{}},',
  '{id:"claude-fable-5-1",family:"fable",display_name:"Fable 5.1",provider_ids:{}},',
  'ults:{},best:"fable",latest_per_family:{fable:"claude-fable-5-1",opus:"claude-opus-5-5",sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"},alias_migration:{}}',
].join('');

describe('Claude Code\'s own model table', () => {
  it('reads what each alias resolves to in this build', () => {
    expect(parseClaudeModelTable(BUNDLE).aliases).toEqual({
      fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5',
    });
  });

  it('names a model the way Claude Code names it', () => {
    const table = parseClaudeModelTable(BUNDLE);
    expect(table.displayNames['claude-opus-5-5']).toBe('Opus 5.5');
    // An older generation of the same family is still in the table, and must
    // not be what `opus` is labelled -- that was the bug.
    expect(table.displayNames[table.aliases.opus!]).toBe('Opus 5.5');
  });

  it('lists the aliases in the order the build declares them', () => {
    expect(claudeModelAliases(parseClaudeModelTable(BUNDLE))).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(claudeModelAliases(undefined)).toEqual([]);
  });

  it('keeps the first name it saw for an id, across chunks', () => {
    const into = parseClaudeModelTable(BUNDLE);
    parseClaudeModelTable('{id:"claude-opus-5-5",family:"opus",display_name:"Something Else"', into);
    expect(into.displayNames['claude-opus-5-5']).toBe('Opus 5.5');
  });

  it('finds nothing in text that is not a bundle', () => {
    expect(parseClaudeModelTable('hello world')).toEqual({ aliases: {}, displayNames: {} });
  });
});

/** Against the Claude Code actually installed, when there is one: the proof
 * that this reads a real bundle rather than a fixture shaped like one. */
const installed = (() => {
  try { return existsSync(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()); } catch { return false; }
})();

describe.runIf(installed)('the installed Claude Code', () => {
  it('yields a table whose aliases all have names', async () => {
    const table = await claudeModelTable('claude');
    expect(table).toBeDefined();
    for (const alias of ['opus', 'sonnet', 'haiku']) {
      expect(table!.aliases[alias], alias).toMatch(/^claude-/);
      expect(claudeModelLabel(alias), alias).toMatch(new RegExp(`^${alias}`, 'i'));
    }
  }, 60_000);
});
