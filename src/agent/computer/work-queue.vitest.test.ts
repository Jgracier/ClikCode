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
