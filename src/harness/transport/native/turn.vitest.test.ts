import { describe, expect, it } from 'vitest';
import { captureNativeHarnessTurn } from './turn.js';

const node = { command: 'node-fixture', binary: process.execPath, displayName: 'Fixture' };

/** A vendor stand-in: prints `lines`, then stays alive and silent. */
function lingering(lines: readonly string[]): string[] {
  return ['-e', `${lines.map((line) => `console.log(${JSON.stringify(line)});`).join('')}setInterval(() => {}, 1000);`];
}

describe('captureNativeHarnessTurn without a silence ceiling', () => {
  it('waits for a quiet vendor, and ends when the user stops it', async () => {
    const controller = new AbortController();
    const turn = captureNativeHarnessTurn(node, lingering(['{"type":"assistant"}']), {}, { signal: controller.signal, onStdoutLine: () => undefined });
    let settled = false;
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(settled, 'no clock of ClikCode\'s own ends it').toBe(false);
    controller.abort();
    expect((await turn).interrupted).toBe(true);
  });
});

describe('captureNativeHarnessTurn interactive sign-in', () => {
  it('stops a vendor that starts its own browser login and fails with the sign-in path', async () => {
    const started = Date.now();
    await expect(captureNativeHarnessTurn(node, lingering([
      'No API key found. Starting login flow...',
      'Waiting for confirmation in the browser...',
    ]), {}, { onStdoutLine: () => undefined }))
      .rejects.toMatchObject({ reason: 'login-prompt', message: expect.stringContaining('sign in') });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not read model text later in a turn as a login prompt', async () => {
    const filler = 'x'.repeat(9_000);
    const output = await captureNativeHarnessTurn(node, ['-e', `console.log(${JSON.stringify(filler)});console.log('Starting login flow... Waiting for confirmation in the browser');`], {}, { onStdoutLine: () => undefined });
    expect(output.exitCode).toBe(0);
  });
});
