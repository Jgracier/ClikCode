import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCli = vi.fn();
vi.mock('./run-cli.js', () => ({ runCli: (...args: unknown[]) => runCli(...args) }));

import { vendorMfaCode } from './secret-destinations.js';

const ok = (code: string, secondsRemaining?: number): { code: number; text: string; missing: false } => ({
  code: 0,
  missing: false,
  // tools run wraps the route body once, and the route wraps the code in its own data: two levels deep.
  text: JSON.stringify({ status: 'ok', data: { status: 'ok', data: { account: 'aws/root', code, ...(secondsRemaining !== undefined ? { secondsRemaining } : {}), period: 30 } } }),
});

describe('vendorMfaCode', () => {
  beforeEach(() => runCli.mockReset());

  it('unwraps the two-level envelope and returns only the code', async () => {
    runCli.mockResolvedValue(ok('123456', 12));
    const res = await vendorMfaCode('aws/root');
    expect(res).toEqual({ code: '123456', secondsRemaining: 12 });
    // It asks ClikDeploy for the code of exactly that account and sends no seed.
    const [, argv] = runCli.mock.calls[0] as [string, string[]];
    expect(argv).toContain('admin_vendor_mfa_code');
    const payload = JSON.parse(argv[argv.indexOf('--args-json') + 1]);
    expect(payload).toEqual({ account: 'aws/root' });
    expect(JSON.stringify(payload)).not.toMatch(/seed/i);
  });

  it('defaults secondsRemaining to 30 when the route omits it', async () => {
    runCli.mockResolvedValue(ok('654321'));
    const res = await vendorMfaCode('vendor/console');
    expect(res).toEqual({ code: '654321', secondsRemaining: 30 });
  });

  it('refuses an empty account without calling the CLI', async () => {
    const res = await vendorMfaCode('   ');
    expect(res).toEqual({ error: 'no account given' });
    expect(runCli).not.toHaveBeenCalled();
  });

  it('reports the reason when ClikDeploy returns an error envelope', async () => {
    runCli.mockResolvedValue({ code: 0, missing: false, text: JSON.stringify({ status: 'ok', data: { status: 'error', reason: 'no seed stored for aws/root' } }) });
    const res = await vendorMfaCode('aws/root');
    expect(res).toEqual({ error: 'no seed stored for aws/root' });
  });

  it('reads the reason out of the CLI error shape (error: { code, message })', async () => {
    runCli.mockResolvedValue({ code: 1, missing: false, text: JSON.stringify({ status: 'error', command: 'tools run', error: { code: 'NOT_FOUND', message: 'No such account' } }) });
    expect(await vendorMfaCode('aws/root')).toEqual({ error: 'No such account' });
  });

  it('reports a plain reason when the clikdeploy CLI is not installed', async () => {
    runCli.mockResolvedValue({ code: null, missing: true, text: '' });
    const res = await vendorMfaCode('aws/root');
    expect(res).toEqual({ error: 'the clikdeploy CLI is not installed on this machine' });
  });

  it('never surfaces a seed even if the envelope carries extra fields', async () => {
    runCli.mockResolvedValue({ code: 0, missing: false, text: JSON.stringify({ status: 'ok', data: { status: 'ok', data: { account: 'aws/root', code: '111222', secondsRemaining: 5, seed: 'SHOULDNOTLEAK' } } }) });
    const res = await vendorMfaCode('aws/root');
    expect(res).toEqual({ code: '111222', secondsRemaining: 5 });
    expect(JSON.stringify(res)).not.toMatch(/SHOULDNOTLEAK/);
  });
});
