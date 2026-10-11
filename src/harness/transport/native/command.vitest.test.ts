import { describe, expect, it } from 'vitest';
import { captureNativeHarnessOutput } from './command.js';

const node = { command: 'node', binary: process.execPath, displayName: 'Node' };

describe('captureNativeHarnessOutput', () => {
  it('has no clock unless asked: a slow helper still answers', async () => {
    const out = await captureNativeHarnessOutput(node, ['-e', "setTimeout(() => console.log('late'), 300)"]);
    expect(out.trim()).toBe('late');
  });

  it('ends a hung helper only on the caller\'s abort', async () => {
    const controller = new AbortController();
    const pending = captureNativeHarnessOutput(node, ['-e', 'setInterval(() => {}, 1000)'], {}, undefined, undefined, undefined, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('still honours an explicit clock', async () => {
    await expect(captureNativeHarnessOutput(node, ['-e', 'setInterval(() => {}, 1000)'], {}, 200)).rejects.toThrow(/timed out/);
  });
});
