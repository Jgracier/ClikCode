import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { listProfiles, normalizePhone, phoneFor, profileKeyFor, removeProfile, saveProfile } from './profiles.js';

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
