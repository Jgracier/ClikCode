/** Opt-in check that a second worker attaches to an existing ClikCode browser. */
import { expect, it } from 'vitest';
import { computerPage } from './browser.js';

it.skipIf(!process.env.CLIKCODE_BROWSER_ATTACH_STATE_DIR)('attaches to the browser from another process', async () => {
  const page = await computerPage(process.env.CLIKCODE_BROWSER_ATTACH_STATE_DIR!);
  expect(page.isClosed()).toBe(false);
  expect(page.context().pages().length).toBeGreaterThan(0);
}, 10_000);
