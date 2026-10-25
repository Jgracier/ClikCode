/** A code split over single-digit boxes is filled from the emailed code, one digit per box, in real Chrome.
 * Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it, vi } from 'vitest';

vi.mock('../computer/email-code.js', async (original) => ({ ...await original<typeof import('../computer/email-code.js')>(), codeFromMailbox: vi.fn(async () => '493027') }));

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const boxes = (extra: string) => Array.from({ length: 6 }, (_, index) => `<input aria-label="Digit ${index + 1}" maxlength="1" inputmode="numeric" ${extra}>`).join('');

it.skipIf(!enabled)('types one emailed digit into each of six single-digit boxes, and leaves other boxes alone', async () => {
  const { askForFills, observeComputerPage } = await import('./computer-web.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-split-code-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(`<h1>Enter the code</h1><div id=otp>${boxes('')}</div>
      <script>const all=[...document.querySelectorAll('#otp input')];all.forEach((box,i)=>box.addEventListener('input',()=>{if(box.value&&all[i+1])all[i+1].focus()}))</script>`)}`);
    const view = (await observeComputerPage(page, false)).output;
    const refs = [...view.matchAll(/textbox "Digit \d" \[ref=(e\d+)\]/g)].map(match => match[1]!);
    expect(refs).toHaveLength(6);
    const steps = await askForFills(page, refs.map(target => ({ do: 'fill' as const, target })), { stateDir, signal: undefined } as never);
    expect(steps.map(step => step.text)).toEqual(['4', '9', '3', '0', '2', '7']);
    for (const step of steps) { const box = page.locator(`aria-ref=${step.target}`); await box.fill(''); await box.pressSequentially(step.text!); }
    expect(await page.locator('#otp input').evaluateAll(nodes => nodes.map(node => (node as unknown as { value: string }).value).join(''))).toBe('493027');
  } finally {
    await browser.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);
