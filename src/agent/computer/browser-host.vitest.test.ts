import { expect, it } from 'vitest';
import { launchFirst } from './browser-host.js';

it('uses the first browser that is installed', async () => {
  const tried: string[] = [];
  const result = await launchFirst(async channel => {
    tried.push(channel);
    if (channel === 'chrome') throw new Error("browserType.launch: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome");
    return channel;
  });
  expect(result).toBe('msedge');
  expect(tried).toEqual(['chrome', 'msedge']);
});

it('does not hide a real launch failure behind another browser', async () => {
  const tried: string[] = [];
  await expect(launchFirst(async channel => { tried.push(channel); throw new Error('The profile is already in use'); })).rejects.toThrow('already in use');
  expect(tried).toEqual(['chrome']);
});

it('says what to install when no browser is present', async () => {
  await expect(launchFirst(async () => { throw new Error("Executable doesn't exist at /x"); })).rejects.toThrow('Chrome or Microsoft Edge');
});
