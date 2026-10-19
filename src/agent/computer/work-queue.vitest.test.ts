import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { listTasks, saveTask, summarizeTasks, taskId } from './work-queue.js';

let stateDir = '';
afterEach(async () => { if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

describe('work queue', () => {
  it('keeps one task per vendor and kind, updates what is given, and drops the reason once the task moves on', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'queue-'));
    expect(taskId('Xero', 'oauth-app')).toBe(taskId(' xero ', 'oauth-app'));
    await saveTask(stateDir, { vendor: 'Xero', status: 'needs-human', reason: 'captcha', note: 'trial needs reCAPTCHA', connectors: ['xero-a'] });
    await saveTask(stateDir, { vendor: 'xero', connectors: ['xero-b'] });
    let [task] = await listTasks(stateDir);
    expect(task).toMatchObject({ vendor: 'xero', status: 'needs-human', reason: 'captcha', connectors: ['xero-a', 'xero-b'] });
    await saveTask(stateDir, { vendor: 'xero', status: 'done', owner: 'gracierdigital@gmail.com' });
    [task] = await listTasks(stateDir);
    expect(task!.reason).toBeUndefined();
    expect(task).toMatchObject({ status: 'done', owner: 'gracierdigital@gmail.com', note: 'trial needs reCAPTCHA' });
    expect(await listTasks(stateDir, { status: 'queued' })).toEqual([]);
  });

  it('summarizes by status and by what waits on a person, and refuses unknown values', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'queue-'));
    await saveTask(stateDir, { vendor: 'a', status: 'needs-human', reason: 'sms' });
    await saveTask(stateDir, { vendor: 'b', status: 'needs-human', reason: 'sms' });
    await saveTask(stateDir, { vendor: 'c', status: 'done' });
    expect(summarizeTasks(await listTasks(stateDir))).toBe('3 tasks: 1 done, 2 needs-human. Waiting on you: 2 sms.');
    await expect(saveTask(stateDir, { vendor: 'd', status: 'nope' as never })).rejects.toThrow('Unknown status');
  });
});

describe('secret records', () => {
  it('records vendor, owner and dates, keeps the first date on a rotation, and backfills old secrets from their name', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'secret-meta-'));
    const { saveNamedSecret, namedSecretInfo, backfillSecretMeta, readNamedSecret } = await import('./credential-vault.js');
    await saveNamedSecret(stateDir, 'netlify/client-id', 'one', { vendor: 'netlify', owner: 'a@b.test' });
    await saveNamedSecret(stateDir, 'netlify/client-id', 'two');
    const [info] = await namedSecretInfo(stateDir);
    expect(info!.meta).toMatchObject({ vendor: 'netlify', owner: 'a@b.test' });
    expect(info!.meta!.rotatedAt).toBeDefined();
    expect(await readNamedSecret(stateDir, 'netlify/client-id')).toBe('two');
    await saveNamedSecret(stateDir, 'dropbox/client-secret', 'v');
    await saveNamedSecret(stateDir, 'plainname', 'v');
    const done = await backfillSecretMeta(stateDir, 'owner@x.test');
    expect(done.sort()).toEqual(['dropbox/client-secret', 'plainname']);
    const byName = Object.fromEntries((await namedSecretInfo(stateDir)).map(item => [item.name, item.meta]));
    expect(byName['dropbox/client-secret']).toMatchObject({ vendor: 'dropbox', owner: 'owner@x.test' });
    expect(byName['plainname']).toMatchObject({ owner: 'owner@x.test' });
    expect(byName['plainname']!.vendor).toBeUndefined();
    expect(await readNamedSecret(stateDir, 'dropbox/client-secret')).toBe('v');
  });
});

describe('sign-in method hints', () => {
  it('prefers Google, then GitHub, and says nothing when neither is offered', async () => {
    const { signInMethodHint, signInProviders } = await import('../tools/computer-web.js');
    expect(signInProviders('Log in\nContinue with Google\nContinue with GitHub')).toEqual({ google: true, github: true });
    expect(signInProviders('Sign up with GitHub or use email')).toEqual({ google: false, github: true });
    expect(signInProviders('Sign in using Google')).toEqual({ google: true, github: false });
    expect(signInProviders('Welcome. Google Docs, GitHub Pages')).toEqual({ google: false, github: false });
    expect(signInMethodHint({ google: true, github: true })).toContain('offers Google');
    expect(signInMethodHint({ google: false, github: true })).toContain('GitHub and not Google');
    expect(signInMethodHint({ google: false, github: true })).toContain('no Google sign-in of its own');
    expect(signInMethodHint({ google: false, github: false })).toBeUndefined();
  });
});
