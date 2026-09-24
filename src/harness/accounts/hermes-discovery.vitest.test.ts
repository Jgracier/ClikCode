import { describe, expect, it } from 'vitest';
import { hermesCachedModels, hermesInstallDirectory, hermesProviderIds, hermesToolsetNames } from './hermes-discovery';

describe('hermes discovery', () => {
  it('reads model ids out of the provider cache', () => {
    expect(hermesCachedModels(JSON.stringify({
      nous: { models: ['stealth/ox-alpha', ' '] },
      anthropic: { models: ['claude-sonnet'] },
    }))).toEqual(['stealth/ox-alpha', 'claude-sonnet']);
    expect(hermesCachedModels('not json')).toEqual([]);
  });

  it('reads toolset names from hermes tools list', () => {
    const text = [
      'Built-in toolsets (cli):',
      '  ✓ enabled  web  🔍 Web Search',
      '  ✗ disabled  video_gen  🎬 Video',
      'Plugin toolsets (cli):',
      '  ✗ disabled  a2a  🔌 A2A',
    ].join('\n');
    expect(hermesToolsetNames(text)).toEqual(['web', 'video_gen', 'a2a']);
  });

  it('reads provider ids from the install registry', () => {
    const source = [
      'PROVIDER_REGISTRY: Dict[str, ProviderConfig] = {',
      '    "nous": ProviderConfig(',
      '    "openai-api": ProviderConfig(',
      '    "not-a-provider": "x",',
      '}',
    ].join('\n');
    expect(hermesProviderIds(source)).toEqual(['nous', 'openai-api']);
  });

  it('finds the install directory in hermes --version', () => {
    expect(hermesInstallDirectory('Hermes Agent v0.20.5\nInstall directory: /home/me/.hermes/hermes-agent\n')).toBe('/home/me/.hermes/hermes-agent');
  });
});
