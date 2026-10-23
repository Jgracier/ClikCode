import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Conf from 'conf';
import type { ToolContext } from '../tool-contract.js';

const calls = vi.hoisted(() => ({ specs: [] as Array<{ headers: Record<string, string> }>, requests: [] as Array<{ method: string; params: Record<string, unknown>; headers: Record<string, string> }> }));
vi.mock('../../gateway/credentials.js', () => ({ getApiUrl: () => 'https://clikdeploy.test', getApiKeyForUrl: () => 'account-key' }));
vi.mock('../mcp/transport.js', () => ({ openTransport: (spec: { headers: Record<string, string> }) => {
  calls.specs.push(spec);
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.requests.push({ method, params, headers: { ...spec.headers } });
      return method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    setProtocolVersion: () => undefined, notify: () => undefined, close: async () => undefined,
  };
} }));

import { clikDeployStepUpTool } from './clikdeploy-step-up.js';

let configHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;
beforeEach(async () => {
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  configHome = await mkdtemp(join(tmpdir(), 'clikcode-step-up-'));
  process.env.HOME = configHome;
  process.env.XDG_CONFIG_HOME = configHome;
  calls.specs.length = 0;
  calls.requests.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
  await rm(configHome, { recursive: true, force: true });
});

describe('ClikDeploy private step-up', () => {
  it('exchanges an authenticator code and keeps it and the token out of the tool result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { token: 'private-unlock-token' } }), { status: 200 }));
    const result = await clikDeployStepUpTool.run({ action: 'unlock' }, { requestPrivateSecret: async () => '123456' } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect(result.output).not.toMatch(/123456|private-unlock-token/);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ code: '123456' });
    expect(new Conf({ projectName: 'clikdeploy' }).get('adminMfaToken')).toBe('private-unlock-token');
  });

  it('uses a password only as a header for the named admin call', async () => {
    new Conf({ projectName: 'clikdeploy' }).set('adminMfaToken', 'saved-unlock-token');
    const asked: string[] = [];
    const result = await clikDeployStepUpTool.run({ action: 'call', tool: 'admin_users_manage', arguments: { action: 'access_grant', email: 'a@example.com' }, password: true }, {
      requestPrivateSecret: async (name) => { asked.push(name); return 'private-password'; },
    } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect(asked).toEqual(['ClikDeploy super admin']);
    expect(calls.requests[0]!.headers['x-superadmin-password']).toBeUndefined();
    expect(calls.requests[1]!.headers).toMatchObject({ 'x-admin-mfa': 'saved-unlock-token', 'x-superadmin-password': 'private-password' });
    expect(calls.requests[1]!.params).toEqual({ name: 'call_tool', arguments: { name: 'admin_users_manage', arguments: { action: 'access_grant', email: 'a@example.com', confirm: true } } });
    expect(JSON.stringify(calls.requests.map(call => call.params))).not.toContain('private-password');
    expect(result.output).not.toContain('private-password');
  });

  it('refuses credentials in model arguments', async () => {
    const result = await clikDeployStepUpTool.run({ action: 'call', tool: 'admin_users_manage', arguments: { superAdminPassword: 'exposed' }, password: true }, {
      requestPrivateSecret: async () => { throw new Error('must not prompt'); },
    } as ToolContext);
    expect(result.isError).toBe(true);
    expect(calls.requests).toHaveLength(0);
  });
});
