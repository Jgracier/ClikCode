import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callComputerDriver } from './driver.js';
import { closeComputerBrowser, openComputerPage } from './browser.js';

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('connects to Cua Driver directly without a separate daemon', async () => {
  const result = await callComputerDriver('get_desktop_state', {});
  expect(result.isError).not.toBe(true);
  expect(result.content?.length).toBeGreaterThan(0);
}, 30_000);

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('observes a Chrome window and types into the focused desktop', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-cua-smoke-'));
  try {
    const page = await openComputerPage(stateDir);
    await page.goto('data:text/html,<input aria-label="Test input" autofocus>');
    await page.bringToFront();
    await page.getByRole('textbox', { name: 'Test input' }).focus();
    const windows = await callComputerDriver('list_windows', { on_screen_only: true });
    expect(windows.isError, JSON.stringify(windows.content?.filter((part) => part.type === 'text'))).not.toBe(true);
    const listing = windows.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
    const match = listing.match(/\[xid=(\d+)\] pid=Some\((\d+)\).*Google Chrome/);
    expect(match).toBeTruthy();
    const state = await callComputerDriver('get_window_state', {
      pid: Number(match![2]), window_id: Number(match![1]), max_elements: 150, include_screenshot: false,
    });
    expect(state.isError, JSON.stringify(state.content?.filter((part) => part.type === 'text'))).not.toBe(true);
    expect(state.content?.some((part) => part.type === 'text' && part.text.includes('window_id='))).toBe(true);
    const result = await callComputerDriver('type_text', {
      target: { kind: 'desktop', display_id: 'primary' }, text: 'desktop works',
    });
    expect(result.isError, JSON.stringify(result.content?.filter((part) => part.type === 'text'))).not.toBe(true);
    expect(await page.getByRole('textbox', { name: 'Test input' }).inputValue()).toBe('desktop works');
    const selected = await callComputerDriver('hotkey', {
      target: { kind: 'desktop', display_id: 'primary' }, keys: ['ctrl', 'a'],
    });
    expect(selected.isError, JSON.stringify(selected.content?.filter((part) => part.type === 'text'))).not.toBe(true);
    const replaced = await callComputerDriver('type_text', {
      target: { kind: 'desktop', display_id: 'primary' }, text: 'replaced',
    });
    expect(replaced.isError).not.toBe(true);
    expect(await page.getByRole('textbox', { name: 'Test input' }).inputValue()).toBe('replaced');
  } finally {
    await closeComputerBrowser(stateDir);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);
