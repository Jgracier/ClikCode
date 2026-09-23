import { describe, expect, it } from 'vitest';
import { codexModelEffort, parseHelpEffortChoices } from './effort-choices.js';

/** Each help excerpt is copied from the installed CLI, not written to fit. */
describe('effort levels read from a harness\'s own --help', () => {
  it('Claude Code: a parenthesised list on the wrapped description line', () => {
    const help = [
      '  --effort <level>                      Effort level for the current session',
      '                                        (low, medium, high, xhigh, max)',
      '  --environment <environment_id>        Create a new cloud session',
    ].join('\n');
    expect(parseHelpEffortChoices(help, '--effort')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('Cline: a pipe-separated run', () => {
    const help = '  --thinking <level>            Set reasoning effort:\n                                none|low|medium|high|xhigh. Bare --thinking uses';
    expect(parseHelpEffortChoices(help, '--thinking')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
  });

  it('Hermes: past the usage synopsis, to a colon list ending "or ultra"', () => {
    const help = [
      'usage: hermes [--provider PROVIDER] [--reasoning LEVEL] [-t TOOLSETS]',
      '',
      '  --reasoning LEVEL     Reasoning effort for this invocation: none, minimal,',
      '                        low, medium, high, xhigh, max, or ultra. Overrides',
    ].join('\n');
    expect(parseHelpEffortChoices(help, '--reasoning'))
      .toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('Pi: a colon list with no closing period', () => {
    const help = '  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max\n  --extension, -e <path>         Load an extension file';
    expect(parseHelpEffortChoices(help, '--thinking')).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('Copilot: documents a different flag than the one ClikCode sends, in clap style', () => {
    // `--effort` is accepted but undocumented; the levels are on the flag the
    // help does document. ClikCode used to offer Copilot no levels at all.
    const help = '      --reasoning-effort <level>\n          Set the reasoning effort level [possible values: none, minimal, low, medium, high, xhigh, max]';
    expect(parseHelpEffortChoices(help, '--effort')).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('refuses an example, which is not a contract', () => {
    const help = '  --effort <level>                  Set reasoning effort for the session (e.g. low, medium, high) — depends on the model';
    expect(parseHelpEffortChoices(help, '--effort')).toEqual([]);
  });

  it('refuses a list that is not an effort scale', () => {
    const help = '  --reasoning-effort <mode>   Applies to: tools, files, prompts.';
    expect(parseHelpEffortChoices(help, '--reasoning-effort')).toEqual([]);
  });

  it('finds nothing where the help names the flag and lists no levels', () => {
    expect(parseHelpEffortChoices('      --reasoning-effort <EFFORT>\n          Reasoning effort for reasoning models', '--reasoning-effort')).toEqual([]);
  });
});

describe('Codex levels, per model, from its own models_cache.json', () => {
  const cache = JSON.stringify({
    models: [
      { slug: 'gpt-6-sol', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort })) },
      { slug: 'gpt-6-luna', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })) },
    ],
  });

  it('is what the model supports, not what the harness as a whole does', () => {
    expect(codexModelEffort(cache, 'gpt-6-sol')?.values).toContain('ultra');
    // The bug: one list for every Codex model offered `ultra` here.
    expect(codexModelEffort(cache, 'gpt-6-luna')?.values).not.toContain('ultra');
  });

  it('carries the model\'s own default', () => {
    expect(codexModelEffort(cache, 'gpt-6-luna')?.default).toBe('medium');
  });

  it('says nothing about a model it does not list, or a file that is not JSON', () => {
    expect(codexModelEffort(cache, 'gpt-unknown')).toBeUndefined();
    expect(codexModelEffort('not json', 'gpt-6-sol')).toBeUndefined();
  });
});
