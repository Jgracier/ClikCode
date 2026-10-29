/** A key a page shows as plain text (a table cell, a code block, an input value, a data attribute) never reaches the model:
 * observe, evaluate and console give a stable [secret:ref-N] placeholder, and capture_secret can be aimed at it or at the cell's label. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { lockCredentialVault, readNamedSecret } from './credential-vault.js';
import { captureSecret } from './secret-capture.js';
import { forgetSecrets, isSecretRef, resolveSecretRef, scrubSecrets } from './secret-scrubber.js';
import { findLabelledSecret, maskSensitive } from './sensitive-fields.js';
import { hideKeyLikeText } from './secret-finder.js';
import { evaluateOnPage } from './page-control.js';
import { observeComputerPage } from '../tools/computer-web.js';
import { LoginError } from './login-error.js';

const CELL = 'kd83hf72nsl20dkq93js';
const CODE = 'Zx9Kp2LmQ7vRt4YhNb6WcDfGj';
const FIELD = 'qw12er34ty56ui78op90as';
const DATA = 'mn45bv67cx89zl01kj23hg45';
const HTML = `<!doctype html><title>Settings</title><body>
<h1>API Keys</h1>
<table><thead><tr><th>Name</th><th>API Key</th></tr></thead><tbody><tr><td>Legacy</td><td>${CELL}</td></tr></tbody></table>
<p>Install with <code>${CODE}</code></p>
<label>Webhook <input id="w" value="${FIELD}"></label>
<div id="d" data-clipboard-text="${DATA}">Copy</div>
<p>Plain words and a short id e5.</p></body>`;

let browser: Browser | undefined;
let tab: Page | undefined;
let stateDir = '';
beforeAll(async () => {
  try { browser = await chromium.launch({ headless: true }); } catch { try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = undefined; } }
}, 60_000);
afterAll(async () => { await browser?.close(); });
afterEach(async () => { forgetSecrets(); if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } await tab?.close(); tab = undefined; });
const ready = async (): Promise<Page> => { tab = await (await browser!.newContext()).newPage(); await tab.setContent(HTML); return tab; };
const all = [CELL, CODE, FIELD, DATA];
const clean = (text: string): void => { for (const secret of all) expect(text).not.toContain(secret); };

it('observe replaces a key in a cell, a code block, an input and a data attribute with stable placeholders', async ctx => {
  if (!browser) return ctx.skip();
  const page = await ready();
  const first = (await observeComputerPage(page, false)).output;
  clean(first);
  const refs = first.match(/\[secret:ref-\d+\]/g) ?? [];
  expect(new Set(refs).size).toBeGreaterThanOrEqual(2);
  expect(first).toContain('Plain words');
  // Stable: the same page gives the same placeholders again.
  expect((await observeComputerPage(page, false)).output.match(/\[secret:ref-\d+\]/g)).toEqual(refs);
  expect(resolveSecretRef(refs[0]!)).toBeDefined();
}, 60_000);

it('evaluate never returns the values, however it asks for them', async ctx => {
  if (!browser) return ctx.skip();
  const page = await ready();
  for (const expression of ['document.querySelector("td:last-child").textContent', 'document.body.innerText', 'document.querySelector("#d").dataset.clipboardText', 'document.querySelector("#w").value', 'document.body.innerHTML', 'btoa(document.querySelector("code").textContent)', '() => { throw new Error("bad " + document.querySelector("code").textContent); }']) {
    const out = await evaluateOnPage(page, { expression }, { locate: async () => { throw new Error('no'); } }).catch(error => (error as Error).message);
    clean(out); clean(Buffer.from(out).toString());
    expect(out).not.toContain(Buffer.from(CODE).toString('base64'));
  }
}, 60_000);

it('text from the page that comes back later (console, network) is scrubbed once the page has been read', async ctx => {
  if (!browser) return ctx.skip();
  const page = await ready();
  await maskSensitive(page, 'warm up');
  const line = scrubSecrets(`GET /v1?api_key=${CELL} failed: ${FIELD}`);
  clean(line);
  expect(line.match(/\[secret:ref-\d+\]/g)).toHaveLength(2);
  clean(hideKeyLikeText(`curl -H "X-Key: ${CELL}"`).text);
});

it('a plain 20-character key with no label is hidden from text, and ordinary words and refs are not', () => {
  const { text, hidden } = hideKeyLikeText(`- cell "${CELL}" [ref=e5]\n- link "Documentation for the integration settings" [ref=e9]`);
  expect(hidden).toBe(1);
  expect(text).not.toContain(CELL);
  expect(text).toContain('[ref=e9]');
});

it('capture_secret takes the key from a table cell by its label, and by the placeholder, without it being shown', async ctx => {
  if (!browser) return ctx.skip();
  const page = await ready();
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-page-secrets-'));
  expect(await findLabelledSecret(page, 'API key')).toBe(CELL);
  expect(await findLabelledSecret(page, 'Name')).toBeUndefined();
  const check = async (): Promise<{ verdict: 'unchecked'; detail: string }> => ({ verdict: 'unchecked', detail: 'test' });
  const byLabel = await captureSecret({ stateDir, page, name: 'pd/legacy', check: check as never, meta: { url: 'https://x.test' }, ask: () => { throw new Error('asked'); },
    readKnown: async () => { const value = await findLabelledSecret(page, 'API key'); return value ? { value, from: 'cell' } : undefined; } });
  expect(byLabel.via).toBe('cell');
  expect(await readNamedSecret(stateDir, 'pd/legacy')).toBe(CELL);
  // The placeholder the observation printed leads to the same value.
  const ref = (await observeComputerPage(page, false)).output.match(/\[secret:ref-\d+\]/)![0];
  expect(isSecretRef(ref)).toBe(true);
  expect(resolveSecretRef(ref)).toBeDefined();
  await expect(captureSecret({ stateDir, page, name: 'pd/x', check: check as never, ask: () => { throw new Error('asked'); }, readKnown: async () => { throw new LoginError('Not saved: unknown placeholder'); } })).rejects.toThrow('unknown placeholder');
}, 60_000);
