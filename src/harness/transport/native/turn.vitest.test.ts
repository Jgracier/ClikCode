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
