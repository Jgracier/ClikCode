/** References that outlive a covered or redrawn element, a dropdown whose options are buttons in a dialog, and a tab that
 * opens after the click's step has ended, against a real Chrome. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adoptPage, arrivedPages, ownedPages } from '../computer/browser.js';
import { locate, observeComputerPage, runSteps } from './computer-web.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
let stateDir = '';
beforeAll(async () => {
  if (!enabled) return;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-refs-tabs-'));
}, 60_000);
afterAll(async () => { await browser?.close(); if (stateDir) await rm(stateDir, { recursive: true, force: true }); });

const html = (body: string): string => `data:text/html,${encodeURIComponent(body)}`;
const refOf = (view: string, role: string, name: string): string => new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(view)![1]!;
const ctx = (): never => ({ stateDir, signal: undefined }) as never;

it.skipIf(!enabled)('still resolves a reference after a menu covered its element, and after the page redrew it', async () => {
  const page = await browser!.newPage();
  // The way a modal is built: while it is open the page behind it is marked aria-hidden, and a read gives nothing there a reference.
  await page.goto(html(`<div id=main><button id=save onclick="document.title='saved'">Save</button> <button id=again>Again</button>
    <button id=open onclick="document.getElementById('main').setAttribute('aria-hidden','true');document.getElementById('cover').hidden=false">Open menu</button>
    <button id=redraw onclick="const old=document.getElementById('save');const fresh=old.cloneNode(true);fresh.onclick=()=>{document.title='saved again'};old.replaceWith(fresh)">Redraw</button>
    <button id=twin onclick="document.getElementById('main').append(Object.assign(document.createElement('button'),{textContent:'Again'}));document.getElementById('again').replaceWith(Object.assign(document.createElement('button'),{textContent:'Again'}))">Twin</button></div>
    <div id=cover hidden role=listbox style="position:fixed;inset:0;background:#fff">
      <div role=option onclick="document.getElementById('cover').hidden=true;document.getElementById('main').removeAttribute('aria-hidden')">First</div></div>`));
  const first = (await observeComputerPage(page, false)).output;
  const save = refOf(first, 'button', 'Save');
  await page.click('#open');
  const covered = (await observeComputerPage(page, false)).output;
  expect(covered).toContain('Open now');
  expect(covered).not.toContain(`[ref=${save}]`);
  await page.getByRole('option', { name: 'First' }).click();
  await (await locate(page, save)).click();
  expect(await page.title()).toBe('saved');
  // The page replaces the button with a new node that says the same: the reference follows what it was shown as.
  await page.click('#redraw');
  await (await locate(page, save)).click();
  expect(await page.title()).toBe('saved again');
  // Two elements answer to what the reference was: it is not guessed between them.
  const again = refOf(first, 'button', 'Again');
  await page.click('#twin');
  await expect(locate(page, again)).rejects.toThrow(/It was the button "Again", and 2 elements answer to that now/);
  await expect(locate(page, 'e99999')).rejects.toThrow(/Nothing on the page has the reference e99999 now/);
  await page.close();
}, 60_000);

it.skipIf(!enabled)('chooses an option drawn as a button in a dialog with a search box, and says so when no option matches', async () => {
  const page = await browser!.newPage();
  await page.goto(html(`<button id=dd aria-expanded=false>State</button>
    <div id=list role=dialog hidden><input id=q type=search aria-label=search>
      <div id=rows></div></div>
    <script>const dd=document.getElementById('dd'),list=document.getElementById('list'),q=document.getElementById('q'),rows=document.getElementById('rows');
      const all=['AL','AK','AZ','AR','CA','CO','CT'];
      const draw=()=>{rows.innerHTML='';for(const name of all.filter(n=>n.toLowerCase().includes(q.value.toLowerCase()))){const row=document.createElement('div');const b=document.createElement('button');b.textContent=name;b.onclick=()=>{dd.textContent=name;list.hidden=true;dd.setAttribute('aria-expanded','false')};row.append(b,document.createElement('hr'));rows.append(row)}};
      dd.onclick=()=>{list.hidden=false;dd.setAttribute('aria-expanded','true');q.value='';draw();q.focus()};q.oninput=draw;</script>`));
  adoptPage(stateDir, page);
  const view = (await observeComputerPage(page, false)).output;
  const chosen = await runSteps(page, [{ do: 'choose', target: refOf(view, 'button', 'State'), text: 'CO' }], ctx());
  expect(chosen.isError).toBeFalsy();
  expect(chosen.output).toContain('Chose "CO"; the control now shows "CO".');
  expect(await page.locator('#dd').textContent()).toBe('CO');
  // The full name is not an option here: nothing is chosen, nothing is typed and left behind, and the offer is named.
  const missed = await runSteps(page, [{ do: 'choose', target: 'CO', text: 'Colorado' }], ctx());
  expect(missed.isError).toBe(true);
  expect(missed.output).toContain('No option says "Colorado", so nothing was chosen. The list offers: "AL", "AK"');
  expect(await page.locator('#dd').textContent()).toBe('CO');
  expect(await page.locator('#q').inputValue()).toBe('');
  expect(await page.locator('#rows button').count()).toBe(7);
  await page.close();
}, 60_000);

it.skipIf(!enabled)('owns a tab that opens after the click\'s step has ended', async () => {
  const page = await browser!.newPage();
  await page.goto(html(`<button onclick="setTimeout(()=>window.open('about:blank#late'),2600)">Link my account</button>`));
  adoptPage(stateDir, page);
  arrivedPages(stateDir);
  const clicked = await runSteps(page, [{ do: 'click', target: 'Link my account' }], ctx());
  expect(clicked.output).not.toContain('A new tab opened');
  expect(ownedPages(stateDir).pages).toHaveLength(1);
  await page.waitForTimeout(3_200);
  const { pages, current } = ownedPages(stateDir);
  expect(pages).toHaveLength(2);
  expect(current).not.toBe(page);
  expect(current!.url()).toContain('#late');
  expect(arrivedPages(stateDir)).toEqual([current]);
  expect(arrivedPages(stateDir)).toEqual([]);
  await current!.close();
  await page.close();
}, 60_000);
