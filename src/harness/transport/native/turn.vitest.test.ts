import { describe, expect, it } from 'vitest';
import { captureNativeHarnessTurn, createTurnIdleController } from './turn.js';

const node = { command: 'node-fixture', binary: process.execPath, displayName: 'Fixture' };

/** A vendor stand-in: prints `lines`, then stays alive and silent. */
function lingering(lines: readonly string[]): string[] {
  return ['-e', `${lines.map((line) => `console.log(${JSON.stringify(line)});`).join('')}setInterval(() => {}, 1000);`];
}

describe('captureNativeHarnessTurn idle budget', () => {
  it('finishes normally when the vendor goes silent after a successful result', async () => {
    const idle = createTurnIdleController();
    const output = await captureNativeHarnessTurn(node, lingering([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"hi"}',
    ]), {}, {
      idleTimeoutMs: 300,
      idleController: idle,
      onStdoutLine: (line) => { if (line.includes('"type":"result"')) idle.noteResult('success'); },
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain('"result":"hi"');
  });

  it('still reports a hang when no result arrived', async () => {
    const idle = createTurnIdleController();
    await expect(captureNativeHarnessTurn(node, lingering(['{"type":"assistant"}']), {}, {
      idleTimeoutMs: 300, idleController: idle, onStdoutLine: () => undefined,
    })).rejects.toMatchObject({ reason: 'idle-timeout' });
  });

  it('still reports a hang when the result was a failure', async () => {
    const idle = createTurnIdleController();
    await expect(captureNativeHarnessTurn(node, lingering(['{"type":"result","is_error":true}']), {}, {
      idleTimeoutMs: 300, idleController: idle, onStdoutLine: () => idle.noteResult('error'),
    })).rejects.toMatchObject({ reason: 'idle-timeout' });
  });
});

describe('captureNativeHarnessTurn interactive sign-in', () => {
  it('stops a vendor that starts its own browser login and fails with the sign-in path', async () => {
    const started = Date.now();
    await expect(captureNativeHarnessTurn(node, lingering([
      'No API key found. Starting login flow...',
      'Waiting for confirmation in the browser...',
    ]), {}, { idleTimeoutMs: 60_000, onStdoutLine: () => undefined }))
      .rejects.toMatchObject({ reason: 'login-prompt', message: expect.stringContaining('sign in') });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not read model text later in a turn as a login prompt', async () => {
    const filler = 'x'.repeat(9_000);
    const output = await captureNativeHarnessTurn(node, ['-e', `console.log(${JSON.stringify(filler)});console.log('Starting login flow... Waiting for confirmation in the browser');`], {}, { onStdoutLine: () => undefined });
    expect(output.exitCode).toBe(0);
  });
});
