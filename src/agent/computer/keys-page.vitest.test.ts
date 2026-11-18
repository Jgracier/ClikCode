import { describe, expect, it } from 'vitest';
import { publicKeysPage, recordKeysPage } from './keys-page.js';

const me = ['gracierdigital', 'gracier', 'clikdeploy'];

describe('the key page, as a link anyone can follow', () => {
  it.each([
    ['https://creator.voiceflow.com/settings/personal-keys', 'https://creator.voiceflow.com/settings/personal-keys'],
    ['https://app.pickfu.com/settings/api-keys?tab=2&token=abc', 'https://app.pickfu.com/settings/api-keys'],
    ['https://app-na2.hubspot.com/service-keys/243104553', 'https://app-na2.hubspot.com/service-keys'],
    ['https://disqus.com/api/applications/8211082/', 'https://disqus.com/api/applications'],
    ['https://clikdeploy-test.agilecrm.com/#api-key', undefined],
    ['https://app.bookafy.com/integrations#api', 'https://app.bookafy.com/integrations#api'],
    ['https://app.supersend.io/org/admin?tab=system', 'https://app.supersend.io/org/admin'],
  ])('%s', (page, link) => { expect(publicKeysPage(page, me)).toBe(link); });

  it('records nothing for a page that is this account\'s own: a tenant host, or an id or name inside the path', () => {
    for (const page of [
      'https://gracierdigital.createsend.com/account/apikeys',
      'https://app.formfeed.dev/en/o/gracier-digital/w/default/keys',
      'https://dashboard.loopmessage.com/organization/e7b24145-4ef0-4fc0-b032-8658b3afa991/api/settings',
      'https://dashboard.promptlayer.com/workspace/{workspace_id}/settings/promptlayer-api-keys',
      'https://app.harness.io/ng/account/<accountId>/all/user/profile/api-keys',
      'https://editor.flotiq.com/s/default-space-77ef2dde/api-keys',
      'https://app.formstep.io/ks78mtvh39kpbabz8ax76x70dd8j80we/credentials',
    ]) expect(publicKeysPage(page, me)).toBeUndefined();
  });

  it('is not a docs page or an insecure address', () => {
    expect(publicKeysPage('https://docs.activecalculator.com/api-reference/introduction', me)).toBeUndefined();
    expect(publicKeysPage('http://app.example.com/settings/api', me)).toBeUndefined();
  });
});

describe('recording it on the connector', () => {
  it('writes access.keysUrl once, and not again when the spec already says it', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let keysUrl: string | undefined;
    const tool = async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === 'connector_spec_get') return { spec: { id: 'pickfu', ...(keysUrl ? { access: { keysUrl } } : {}) } };
      keysUrl = 'https://app.pickfu.com/settings/api-keys';
      return {};
    };
    expect(await recordKeysPage('/nonexistent', 'pickfu', 'https://app.pickfu.com/settings/api-keys?x=1', { tool })).toEqual({ recorded: 'https://app.pickfu.com/settings/api-keys' });
    expect(calls.find(([name]) => name === 'connector_spec_patch')?.[1]).toEqual({ id: 'pickfu', ops: [{ op: 'merge', path: '/', value: { access: { keysUrl: 'https://app.pickfu.com/settings/api-keys' } } }] });
    calls.length = 0;
    expect(await recordKeysPage('/nonexistent', 'pickfu', 'https://app.pickfu.com/settings/api-keys', { tool })).toEqual({ recorded: 'https://app.pickfu.com/settings/api-keys' });
    expect(calls.map(([name]) => name)).toEqual(['connector_spec_get']);
  });

  it('never throws when ClikDeploy refuses: the key is already delivered', async () => {
    const tool = async () => { throw new Error('held for approval'); };
    expect(await recordKeysPage('/nonexistent', 'pickfu', 'https://app.pickfu.com/settings/api-keys', { tool })).toEqual({ skipped: expect.stringContaining('held for approval') });
  });
});
