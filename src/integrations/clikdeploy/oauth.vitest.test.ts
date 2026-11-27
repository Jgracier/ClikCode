import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../../agent/computer/secret-destinations.js', () => ({ connectionState: vi.fn() }));
import { startViaCli } from './oauth.js';
import { authorizationUrl } from '../../agent/computer/oauth-authorization.js';

afterEach(() => { vi.clearAllMocks(); });

it('does not spawn for a cancelled request, and promptly cancels an in-flight CLI', async () => {
  const cancelled = AbortSignal.abort(new Error('cancelled'));
  await expect(startViaCli('acme', cancelled)).rejects.toThrow('cancelled');
  expect(spawn).not.toHaveBeenCalled();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const abort = new AbortController();
  const pending = startViaCli('acme', abort.signal);
  abort.abort(new Error('stop now'));
  await expect(pending).rejects.toThrow('stop now');
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('keeps callback policy explicit and ignores nested problem documents from any platform', () => {
  const owns = (u: URL) => u.hostname === 'platform.example';
  expect(authorizationUrl(JSON.stringify({ data: { type: 'https://issues.example/auth', url: 'https://vendor.example/fail' } }), owns)).toBeUndefined();
  expect(authorizationUrl(JSON.stringify({ authorizationUrl: 'https://vendor.example/auth?redirect_uri=https%3A%2F%2Fplatform.example%2Fcallback' }), owns)).toContain('vendor.example/auth');
});
