import { describe, expect, it } from 'vitest';
import { hermesCachedModels, hermesInstallDirectory, hermesInventory, hermesToolsetNames } from './hermes-discovery';

describe('hermes discovery', () => {
  it('reads model ids out of the provider cache', () => {
    expect(hermesCachedModels(JSON.stringify({
      nous: { models: ['stealth/ox-alpha', ' '] },
      anthropic: { models: ['claude-sonnet'] },
    }))).toEqual(['nous:stealth/ox-alpha', 'anthropic:claude-sonnet']);
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

  it('finds the install directory in hermes --version', () => {
    expect(hermesInstallDirectory('Hermes Agent v0.20.5\nInstall directory: /home/me/.hermes/hermes-agent\n')).toBe('/home/me/.hermes/hermes-agent');
  });

  it('lists ready providers\' models and offers a sign-in for the rest', () => {
    const output = 'Copilot token exchange degraded\n\x00HERMES_INVENTORY' + JSON.stringify({
      providers: [
        { provider: 'openai-codex', name: 'ChatGPT or Codex Subscription', ready: true, models: ['gpt-6-astra'] },
        { provider: 'anthropic', name: 'Anthropic', ready: true, models: ['claude-sonnet-5', ''] },
        { provider: 'nous', name: 'Nous Portal', ready: false, authType: 'oauth_device_code', models: ['hermes-4'] },
        { provider: 'openrouter', name: 'OpenRouter', ready: false, authType: 'api_key', models: [] },
        { provider: 'bedrock', name: 'AWS Bedrock', ready: false, authType: 'aws_sdk', models: [] },
        { provider: 'xai-oauth', name: 'xAI Grok OAuth', ready: false, authType: 'oauth_external', models: [] },
      ],
      model: 'gpt-6-astra', provider: 'openai-codex',
    }) + '\n';
    const inventory = hermesInventory(output)!;
    expect(inventory.models).toEqual(['openai-codex:gpt-6-astra', 'anthropic:claude-sonnet-5']);
    expect(inventory.configured).toBe('openai-codex:gpt-6-astra');
    // The id already says provider and model; a label repeating them was
    // the picker's duplicated row.
    expect(inventory.labels['anthropic:claude-sonnet-5']).toBeUndefined();
    expect(inventory.connect.map((item) => [item.id, item.argv.join(' ')])).toEqual([
      ['nous', 'auth add nous'],
      ['xai-oauth', 'auth add xai-oauth'],
      ['openrouter', 'auth add openrouter'],
      ['bedrock', 'model'],
    ]);
    expect(hermesInventory('Traceback: no module'), 'an install without the inventory').toBeUndefined();
  });
});
