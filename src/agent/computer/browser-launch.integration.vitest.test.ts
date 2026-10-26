/** The no-Chrome fallback against the real Playwright download. Heavy (hundreds of MB): CLIKCODE_COMPUTER_DOWNLOAD=1 as well as CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserType } from 'playwright-core';
import { expect, it } from 'vitest';
import { launchComputerBrowser, readHostStatus } from './browser-launch.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1' && process.env.CLIKCODE_COMPUTER_DOWNLOAD === '1';

it.skipIf(!enabled)('with no Chrome or Edge, downloads Playwright\'s Chromium once, reports progress, and runs it headless', async () => {
  const state = await mkdtemp(join(tmpdir(), 'clikcode-nochrome-state-'));
  // (The test run's HOME is a temporary one, so the download lands in its own empty browser cache.)
  // Pretend Chrome and Edge are absent; the bundled Chromium is real.
  const noChannels = { launchPersistentContext: (profile: string, options: { channel?: string }) => {
    if (options.channel) return Promise.reject(new Error(`browserType.launchPersistentContext: Chromium distribution '${options.channel}' is not found at /nowhere`));
    return chromium.launchPersistentContext(profile, options as never);
  } } as unknown as BrowserType;
  const progress: string[] = [];
  try {
    const context = await launchComputerBrowser(noChannels, join(state, 'profile'), { headless: true }, state, async onProgress => {
      const { installChromium } = await import('./browser-launch.js');
      await installChromium(line => { progress.push(line); onProgress(line); });
    });
    const page = await context.newPage();
    await page.setContent('<h1>hello</h1>');
    expect(await page.locator('h1').innerText()).toBe('hello');
    await context.close();
    expect(progress.some(line => /\d+% of/.test(line))).toBe(true);
    expect(await readHostStatus(state)).toMatchObject({ state: 'starting' });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}, 600_000);
