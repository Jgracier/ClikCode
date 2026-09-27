import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn } from './harness';
import { ModelClientError } from '../agent/models/gateway-client';
import { ScriptedModelClient } from '../agent/testing';
import type { HarnessSession } from '../session/model';

const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
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
  }, 20_000);
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
