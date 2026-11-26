import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { fillTarget } from './page-control.js';

it.skipIf(process.env.CLIKCODE_COMPUTER_SMOKE !== '1')('commits a typed field after a snapshot stops exposing its reference', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input aria-label="Card number" onblur="this.dataset.committed=\'yes\'">');
    let refreshed: Promise<unknown> = Promise.resolve();
    await page.exposeFunction('refreshRefs', () => {
      refreshed = page.ariaSnapshot({ mode: 'ai' } as never);
      return refreshed;
    });
    await page.evaluate(() => {
      const input = document.querySelector('input')!;
      input.addEventListener('input', () => {
        if (input.value.length === 4) {
          input.setAttribute('aria-hidden', 'true');
          void (window as unknown as { refreshRefs(): Promise<unknown> }).refreshRefs();
        }
      });
    });
    const snapshot = await page.ariaSnapshot({ mode: 'ai' } as never);
    const ref = /textbox "Card number" \[ref=(\w+)\]/.exec(snapshot)![1]!;
    const start = Date.now();
    await fillTarget(page, page.locator(`aria-ref=${ref}`), '1234', ref);
    await refreshed;
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(await page.locator('input').inputValue()).toBe('1234');
    expect(await page.locator('input').getAttribute('data-committed')).toBe('yes');
    expect(await page.locator(`aria-ref=${ref}`).count()).toBe(0);
  } finally { await browser.close(); }
}, 15_000);
