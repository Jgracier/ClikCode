import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn } from './harness';
import { ModelClientError } from '../agent/models/gateway-client';
import { ScriptedModelClient } from '../agent/testing';
import type { HarnessSession } from '../session/model';

// A turn saves its conversation under the state directory; without its own,
// every run appended to ~/.clikcode/sessions/gw-1 and the next run's model
// was handed all of it. HOME too: with a state directory set, a turn's first
// MCP load imports the servers the user gave their vendor harnesses (from
// ~/.claude.json and friends) and starts them -- the developer's real `npx -y`
// servers, which took 5-10s and timed tests out.
const previous = { CLIKCODE_HOME: process.env.CLIKCODE_HOME, HOME: process.env.HOME };
const created: string[] = [];
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
beforeEach(() => {
  process.env.CLIKCODE_HOME = temporary('gw-home-');
  process.env.HOME = temporary('gw-user-');
});
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const workspace = (): string => {
  const dir = temporary('gw-');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return dir;
};

const session = (cwd: string): HarnessSession => ({
  id: 'gw-1', conversationId: 'gw-1', route: 'gateway', accountId: null,
  provider: 'gateway', model: null, effort: 'platform-managed',
  accountFailover: 'never', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', workspace: cwd, messages: [],
} as unknown as HarnessSession);

describe('a gateway turn runs the agent loop on this machine', () => {
  it('reaches the local filesystem through its own tools', async () => {
    const cwd = workspace();
    const activity: string[] = [];
    let answer = '';
    // Step one asks to read a real file on this machine; step two answers.
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] },
      { text: 'It exports a.' },
    ]);
    const result = await runGatewayHarnessSessionTurn({
      session: session(cwd), prompt: 'what does src/a.ts export?',
      modelClient: client as never,
      onActivity: (event) => activity.push(`${event.kind}:${event.label}`),
      onResponseDelta: (text) => { answer += text; },
    });
    expect(result.text || answer).toContain('exports a');
    // The point of the whole exercise: a gateway session read a local file,
    // and the file's real contents reached the model on the second step.
    expect(activity.join(' ')).toMatch(/a\.ts/);
    const second = client.requests[1];
    expect(JSON.stringify(second?.items ?? []), 'the tool result never reached the model')
      .toContain('export const a = 1;');
  });
});

describe('a headless turn', () => {
  it('tells the model a command could not be approved, not that the user declined it', async () => {
    const cwd = workspace();
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'bash', args: { command: 'python3 greet.py' } }] },
      { text: 'done' },
    ]);
    await runGatewayHarnessSessionTurn({
      session: { ...session(cwd), permissionMode: 'auto' } as HarnessSession, prompt: 'run it',
      modelClient: client as never,
    });
    const seen = JSON.stringify(client.requests[1]?.items ?? []);
    expect(seen).toMatch(/no approver is attached/);
    expect(seen).not.toMatch(/user declined/);
  });
});

describe('a gateway that cannot serve a harness turn', () => {
  it('streams a titled first reply without its title tag', async () => {
    // Production 2026-09-27: the tag the first turn asks for streamed to the
    // screen, and the streamed copy then won over the stripped answer when the
    // turn was saved -- so the chat kept the tag and never got its name.
    const { StreamingTitle } = await import('../session/title');
    const title = new StreamingTitle();
    let shown = '';
    const client = new ScriptedModelClient([
      { deltas: ['<clikcode-ti', 'tle>Fix math add</clikcode-title>\n', 'Fixed math.js.'] },
    ]);
    await runGatewayHarnessSessionTurn({
      session: session(workspace()), prompt: 'fix it', modelClient: client as never,
      responseFilter: (text, mode) => title.push(text, mode),
      onResponseDelta: (text) => { shown += text; },
    });
    expect(shown).toBe('Fixed math.js.');
    expect(title.title).toBe('Fix math add');
  });

  it('keeps the title out of every step of a multi-step reply', async () => {
    // Production 2026-09-27: step one called a tool; step two opened with the
    // title again, because the conversation every step re-sends carries the
    // title request -- and it reached the screen and the transcript.
    const { StreamingTitle, stripRepeatedTitles, extractSessionTitle } = await import('../session/title');
    const title = new StreamingTitle();
    let shown = '';
    const client = new ScriptedModelClient([
      { deltas: ['<clikcode-title>Fix math add</clikcode-title>\n'], toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] },
      { deltas: ['<clikcode-title>Fix math', ' add</clikcode-title>\n', 'Fixed it.'] },
    ]);
    const result = await runGatewayHarnessSessionTurn({
      session: session(workspace()), prompt: 'fix it', modelClient: client as never,
      responseFilter: (text, mode) => title.push(text, mode),
      onStepStart: () => { const held = title.flush(); if (held) shown += held; title.nextStep(); },
      onResponseDelta: (text) => { shown += text; },
    });
    expect(shown).not.toContain('clikcode-title');
    expect(shown.trim()).toBe('Fixed it.');
    expect(title.title).toBe('Fix math add');
    expect(stripRepeatedTitles(extractSessionTitle(result.text).text)).toBe('Fixed it.');
  });

  it('is recognised from the administrator kill switch and a missing endpoint', () => {
    expect(gatewayHarnessUnavailable(new ModelClientError('off', { kind: 'server', statusCode: 503, code: 'CLIKCODE_DISABLED' }))).toBe(true);
    expect(gatewayHarnessUnavailable(new ModelClientError('gone', { kind: 'server', statusCode: 404 }))).toBe(true);
  });

  it('is not confused with a turn that genuinely failed', () => {
    // A 500 or a quota refusal is a real failure of a real turn. Falling back
    // to the platform assistant there would answer a coding question with an
    // assistant that cannot see the code, and look like success.
    expect(gatewayHarnessUnavailable(new ModelClientError('boom', { kind: 'server', statusCode: 500 }))).toBe(false);
    expect(gatewayHarnessUnavailable(new Error('socket hang up'))).toBe(false);
  });

  it('says why it fell back, and what the fallback cannot do', () => {
    const notice = gatewayHarnessFallbackNotice(new ModelClientError('off', { kind: 'server', statusCode: 503, code: 'CLIKCODE_DISABLED' }));
    expect(notice).toContain('disabled by an administrator');
    expect(notice, 'the user is not told what they lose').toContain('cannot read local files');
  });
});
