/** AWS WAF's CAPTCHA ("Let's confirm you are human"). Unlike the frame-based widgets it is the page itself: a
 * `.amzn-captcha-root` in the top frame, first a splash with a Begin button, then a 3x3 picture grid drawn on one canvas
 * with a transparent `button.amzn-grid-cell` over each square, an instruction in `#amzn-grid-instructions` and a Confirm
 * button. The grid is read and answered by the same square-by-square voting as reCAPTCHA's (human-check-grid.ts);
 * this file only says where the widget is. Measured live on onfleet.com/signup (answered with `x-amzn-waf-action: captcha`). */
import type { Page } from 'playwright-core';
import type { Box } from './human-check-hands.js';

/** Runs in the page: where AWS WAF's Begin button or picture grid is, or null when this page has neither. */
const AWS_WAF_STATE = `(() => {
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden'; };
  const root = document.querySelector('.amzn-captcha-root') || document.querySelector('#captcha-container');
  if (!root) return null;
  const cells = Array.from(root.querySelectorAll('button.amzn-grid-cell')).filter(shown);
  if (cells.length) return { stage: 'grid', region: rect(root.querySelector('.amzn-captcha-root') || root) };
  // The splash: a Begin button inside the widget's own container, never a "Begin" elsewhere on a page.
  const begin = Array.from(root.querySelectorAll('button')).find(b => shown(b) && /^begin\\b/i.test((b.innerText || b.textContent || '').trim()));
  return begin ? { stage: 'begin', begin: rect(begin) } : null;
})()`;

export type AwsWafState = { stage: 'begin'; begin: Box } | { stage: 'grid'; region: Box };

export async function awsWafState(page: Page): Promise<AwsWafState | undefined> {
  const state = await page.evaluate(AWS_WAF_STATE).catch(() => null) as AwsWafState | null;
  return state ?? undefined;
}
