import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { customFieldFor, describeProfile, listProfiles, normalizePhone, phoneFor, profileKeyFor, removeProfile, saveProfile } from './profiles.js';

let stateDir = '';
afterEach(async () => { if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

describe('profileKeyFor', () => {
  it('uses the autocomplete token first, then the words, and never offers a password, code or card', () => {
    expect(profileKeyFor({ autocomplete: 'given-name', type: 'text', text: 'Name' })).toBe('given_name');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Last Name lastName' })).toBe('family_name');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Zip/Postal Code' })).toBe('postal_code');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Address Line 2' })).toBe('address_line2');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Address Line 1' })).toBe('address_line1');
    expect(profileKeyFor({ autocomplete: '', type: 'tel', text: 'Mobile' })).toBe('phone');
    expect(profileKeyFor({ autocomplete: 'one-time-code', type: 'text', text: 'Verification code' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: 'cc-number', type: 'text', text: 'Card number' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: 'new-password', type: 'password', text: 'Password' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Favourite colour' })).toBeUndefined();
  });
});

describe('phone', () => {
  it('is kept as +1 and ten digits and laid out the way the field shows it', () => {
    expect(normalizePhone('(719) 555-0123')).toBe('+17195550123');
    expect(normalizePhone('1-719-555-0123')).toBe('+17195550123');
    expect(phoneFor('+17195550123', '(702) 123-4567')).toBe('(719) 555-0123');
    expect(phoneFor('+17195550123', '702-123-4567')).toBe('719-555-0123');
    expect(phoneFor('+17195550123', '', '+1')).toBe('+17195550123');
    expect(phoneFor('+17195550123', '1234567890')).toBe('7195550123');
  });
});

describe('profiles', () => {
  it('are kept encrypted, merged by label, corrected in place, and removed', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const first = await saveProfile(stateDir, { label: 'Personal', fields: { given_name: 'Ada', phone: '(719) 555-0123' } });
    await saveProfile(stateDir, { label: 'personal', fields: { city: 'Calhan', state: ' ' } });
    await saveProfile(stateDir, { label: 'Company', fields: { organization: 'Lovelace Ltd' } });
    const all = await listProfiles(stateDir);
    expect(all.map(profile => profile.label)).toEqual(['Company', 'Personal']);
    expect(all.find(profile => profile.id === first.id)!.fields).toEqual({ given_name: 'Ada', phone: '+17195550123', city: 'Calhan' });
    await saveProfile(stateDir, { id: first.id, fields: { phone: '719 555 9999' } });
    expect((await listProfiles(stateDir)).find(profile => profile.id === first.id)!.fields.phone).toBe('+17195559999');
    await expect(saveProfile(stateDir, { fields: { password: 'x' } })).rejects.toThrow('Unknown profile field');
    expect(await removeProfile(stateDir, first.id)).toBe(true);
    expect((await listProfiles(stateDir)).map(profile => profile.label)).toEqual(['Company']);
  });
});

describe('custom details an agent asked for', () => {
  const hint = (text: string, type = 'text') => ({ autocomplete: '', type, text });

  it('are kept beside the standard fields, merged by key, and removed by an empty value', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const saved = await saveProfile(stateDir, { label: 'ClikDeploy apps', fields: { organization: 'ClikDeploy' }, custom: {
      app_name: { label: 'App name', value: ' ClikDeploy ', match: ['App Name', 'application name', 'x'] },
      privacy_policy_url: { label: 'Privacy policy', value: 'https://clikdeploy.com/legal/privacy' },
    } });
    expect(saved.custom).toEqual({
      app_name: { label: 'App name', value: 'ClikDeploy', match: ['app name', 'application name'] },
      privacy_policy_url: { label: 'Privacy policy', value: 'https://clikdeploy.com/legal/privacy' },
    });
    // A later value keeps the label and words; an empty one removes the field.
    const again = await saveProfile(stateDir, { id: saved.id, fields: {}, custom: { app_name: { value: 'ClikDeploy Gateway' }, privacy_policy_url: { value: '' } } });
    expect(again.custom).toEqual({ app_name: { label: 'App name', value: 'ClikDeploy Gateway', match: ['app name', 'application name'] } });
    expect((await listProfiles(stateDir))[0]!.custom).toEqual(again.custom);
    expect(describeProfile(again)).toContain('app_name=ClikDeploy Gateway');
  });

  it('refuse a secret, a standard name, a bad name and too much', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    await expect(saveProfile(stateDir, { fields: {}, custom: { client_secret: { value: 'Zq8xW3vLm9PaRt5YcN2bKd7HgF4jS6eU' } } })).rejects.toThrow('looks like a key');
    await expect(saveProfile(stateDir, { fields: {}, custom: { email: { value: 'a@b.co' } } })).rejects.toThrow('standard profile field');
    await expect(saveProfile(stateDir, { fields: {}, custom: { 'App Name': { value: 'x' } } })).rejects.toThrow('lower-case');
    await expect(saveProfile(stateDir, { fields: {}, custom: { app_description: { value: 'x'.repeat(2001) } } })).rejects.toThrow('longer than');
    // A description with a URL and an email in it is not a secret.
    const ok = await saveProfile(stateDir, { fields: {}, custom: { support: { value: 'Write to support@clikdeploy.com or see https://clikdeploy.com/support' } } });
    expect(ok.custom?.support?.value).toContain('support@clikdeploy.com');
  });

  it('match a form field by the words the agent gave, the most specific first, and never a password, code or card', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const profile = await saveProfile(stateDir, { fields: { email: 'ada@example.com' }, custom: {
      app_name: { label: 'App name', value: 'ClikDeploy', match: ['app name', 'application name'] },
      support_email: { label: 'Support email', value: 'support@clikdeploy.com', match: ['support email'] },
      homepage: { label: 'Homepage URL', value: 'https://clikdeploy.com' },
    } });
    expect(customFieldFor(profile, hint('Application name *'))?.field.value).toBe('ClikDeploy');
    expect(customFieldFor(profile, hint('Support email address'))?.key).toBe('support_email');
    // Its label and name stand in when no words were given.
    expect(customFieldFor(profile, hint('Homepage URL'))?.key).toBe('homepage');
    // A form's plain "Email" is the standard field's, not the support email's.
    expect(customFieldFor(profile, hint('Email'))).toBeUndefined();
    expect(customFieldFor(profile, hint('Favourite colour'))).toBeUndefined();
    expect(customFieldFor(profile, hint('App name verification code'))).toBeUndefined();
    expect(customFieldFor(profile, hint('App name', 'password'))).toBeUndefined();
    expect(customFieldFor({ }, hint('App name'))).toBeUndefined();
  });
});
