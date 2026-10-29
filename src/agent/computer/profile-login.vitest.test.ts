import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import type { LoginField } from './login-fields.js';
import { Parked, park, reasonFor, vendorOf } from './parking.js';
import { profileLoginAnswers } from './profile-login.js';
import { saveProfile, saveProfileSecret } from './profiles.js';
import { setUnattended, unattendedEnabled } from './settings.js';
import { listTasks } from './work-queue.js';

let stateDir = '';
afterEach(async () => { if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });
const field = (key: string, kind: LoginField['kind'] = 'text', extra: Partial<LoginField> = {}): LoginField => ({ index: 0, key, label: key, kind, required: true, ...extra });

describe('profileLoginAnswers', () => {
  it('answers email and password fields from the profile, and nothing else', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'plogin-'));
    const profile = await saveProfile(stateDir, { label: 'Personal', fields: { email: 'a@x.test', sso_email: 'sso@x.test' } });
    expect(await profileLoginAnswers(stateDir, [field('email'), field('password', 'password')])).toBeUndefined();
    await saveProfileSecret(stateDir, profile.id, 'password', 'pw-secret-1');
    expect(await profileLoginAnswers(stateDir, [field('email'), field('password', 'password')])).toEqual({ email: 'sso@x.test', password: 'pw-secret-1' });
    expect(await profileLoginAnswers(stateDir, [field('password', 'password')])).toEqual({ password: 'pw-secret-1' });
    expect(await profileLoginAnswers(stateDir, [field('code', 'text', { transient: true })])).toBeUndefined();
    expect(await profileLoginAnswers(stateDir, [field('account', 'choice')])).toBeUndefined();
    expect(await profileLoginAnswers(stateDir, [field('favourite_colour')])).toBeUndefined();
    expect(await profileLoginAnswers(stateDir, [])).toBeUndefined();
  });

  it('a NAMED profile answers before Personal, email and password together (an AWS root account is not the user\'s own email)', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'plogin-'));
    const me = await saveProfile(stateDir, { label: 'Personal', fields: { email: 'me@x.test', sso_email: 'me@x.test' } });
    const aws = await saveProfile(stateDir, { label: 'AWS', fields: { sso_email: 'root@corp.test' } });
    await saveProfileSecret(stateDir, me.id, 'password', 'my-pw');
    await saveProfileSecret(stateDir, aws.id, 'password', 'aws-pw');
    const both = [field('email'), field('password', 'password')];
    expect(await profileLoginAnswers(stateDir, both, 'aws')).toEqual({ email: 'root@corp.test', password: 'aws-pw' });
    expect(await profileLoginAnswers(stateDir, both)).toEqual({ email: 'me@x.test', password: 'my-pw' });
    expect(await profileLoginAnswers(stateDir, both, 'no such profile')).toEqual({ email: 'me@x.test', password: 'my-pw' });
  });

  it('uses Personal before an admin profile that sorts ahead of it by label', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'plogin-'));
    const admin = await saveProfile(stateDir, { label: 'ClikDeploy', fields: { email: 'admin@x.test', given_name: 'A' } });
    const me = await saveProfile(stateDir, { label: 'Personal', fields: { email: 'me@x.test' } });
    await saveProfileSecret(stateDir, admin.id, 'password', 'admin-pw');
    await saveProfileSecret(stateDir, me.id, 'password', 'my-pw');
    expect(await profileLoginAnswers(stateDir, [field('email'), field('password', 'password')])).toEqual({ email: 'me@x.test', password: 'my-pw' });
  });
});

describe('unattended parking', () => {
  it('names the vendor from the site and the reason from the labels', () => {
    expect(vendorOf('https://oauth.pipedrive.com/auth/login')).toBe('pipedrive');
    expect(vendorOf('https://www.example.co.uk/x')).toBe('example');
    expect(reasonFor([field('code', 'text', { label: 'Verification code', transient: true })])).toBe('two-factor');
    expect(reasonFor([field('x', 'text', { label: 'Solve the captcha' })])).toBe('captcha');
    expect(reasonFor([field('phone', 'text', { label: 'Phone number' })])).toBe('sms');
    expect(reasonFor([field('password', 'password', { label: 'Password' })])).toBe('other');
  });

  it('records a needs-human task and stops the step with a message that tells the agent to move on', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'park-'));
    await expect(park(stateDir, 'https://app.acme.com/login', [field('code', 'text', { label: 'Verification code', transient: true })])).rejects.toBeInstanceOf(Parked);
    const [task] = await listTasks(stateDir);
    expect(task).toMatchObject({ vendor: 'acme', status: 'needs-human', reason: 'two-factor', note: 'needs from you: Verification code' });
    await expect(park(stateDir, 'https://app.acme.com/login', [field('p', 'password', { label: 'Password' })])).rejects.toThrow('Do not ask the user; go on to the next vendor');
  });

  it('is a setting that is off until turned on', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'unatt-'));
    expect(await unattendedEnabled(stateDir)).toBe(false);
    await setUnattended(stateDir, true);
    expect(await unattendedEnabled(stateDir)).toBe(true);
  });
});
