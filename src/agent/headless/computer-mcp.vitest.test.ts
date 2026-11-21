import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockedAddress, computerMcpHandler } from './computer-mcp.js';
import { parseActivity } from './activity.js';

type Reply = { result: { isError: boolean; content: Array<{ text: string }> } };
const tool = (seen: Array<Record<string, unknown>>, output = (_: Record<string, unknown>) => 'ok') => ({ name: 'browser_use', description: 'd', parameters: { type: 'object' }, run: async (args: Record<string, unknown>) => { seen.push(args); return { output: output(args) }; } }) as never;

describe('the bounded computer tools server', () => {
  it('refuses a blocked address before it opens, and leaves a page that lands on one unseen', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const landing = tool(seen, args => args.url === 'about:blank' ? 'Page: about:blank' : 'Page: https://us-east-1.console.aws.amazon.com/iam/home\n- button "Create access key"');
    const handle = computerMcpHandler({ tab: 'agent-acme', maxCalls: 10, tools: [landing], stateDir: '/tmp/none', blockUrls: ['^https?://(?:[a-z0-9-]+\\.)*console\\.aws\\.amazon\\.com(?:[/:?#]|$)'], blockMessage: 'Refused: no consoles.' });
    const call = (n: number, args: Record<string, unknown>) => handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'browser_use', arguments: args } }) as Promise<Reply>;
    const direct = await call(1, { action: 'open', url: 'https://console.aws.amazon.com/iam/' });
    expect(direct.result).toMatchObject({ isError: true, content: [{ text: 'Refused: no consoles.' }] });
    expect(seen).toHaveLength(0);
    const landed = await call(2, { action: 'open', url: 'https://acme.example/login' });
    expect(landed.result.isError).toBe(true);
    expect(landed.result.content[0]!.text).not.toMatch(/Create access key/);
    expect(seen.map(a => a.url)).toEqual(['https://acme.example/login', 'about:blank']);
    expect(blockedAddress([/console\.aws/i], { url: 'https://aws.amazon.com/pricing' })).toBe(false);
  });

  it('lists only its tools, forces its own tab, and refuses calls past the budget', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handle = computerMcpHandler({ tab: 'agent-acme', maxCalls: 2, tools: [tool(seen)], stateDir: '/tmp/none', activity: '' });
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map(t => t.name)).toEqual(['browser_use']);
    const call = (n: number, args: Record<string, unknown>) => handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'browser_use', arguments: args } }) as Promise<Reply>;
    expect((await call(1, { action: 'open', tab: 'other' })).result.isError).toBe(false);
    await call(2, { action: 'observe' });
    const third = await call(3, { action: 'observe' });
    expect(third.result.content[0]!.text).toContain('Call budget of 2 used');
    expect(seen).toHaveLength(2);
    expect(seen.every(a => a.tab === 'agent-acme')).toBe(true);
  });

  it('shares one budget with the other servers through the activity file, and marks each call start and end', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'cc-activity-')), 'activity');
    await writeFile(file, '+.+.');
    const seen: Array<Record<string, unknown>> = [];
    const handle = computerMcpHandler({ tab: 't', maxCalls: 3, tools: [tool(seen)], stateDir: '/tmp/none', activity: file });
    const call = (n: number) => handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'browser_use', arguments: {} } }) as Promise<Reply>;
    expect((await call(1)).result.isError).toBe(false);
    expect((await call(2)).result.content[0]!.text).toContain('Call budget of 3 used');
    expect(parseActivity(await readFile(file, 'utf8'))).toEqual({ started: 3, finished: 3, inFlight: false });
  });

  it('binds its tab to the egress before the first call, once, and nothing for home', async () => {
    const bound: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const handle = computerMcpHandler({ tab: 'agent-acme', maxCalls: 5, egress: 'prod', stateDir: '/tmp/none', tools: [tool(seen)], bindEgress: async (_dir, tab, egress) => { bound.push(`${tab}->${egress}`); } });
    for (const id of [1, 2]) await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_use', arguments: {} } });
    expect(bound).toEqual(['agent-acme->prod']);
    const home = computerMcpHandler({ tab: 'x', maxCalls: 5, egress: 'home', stateDir: '/tmp/none', tools: [tool(seen)], bindEgress: async () => { bound.push('home'); } });
    await home({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_use', arguments: {} } });
    expect(bound).toEqual(['agent-acme->prod']);
  });
});
