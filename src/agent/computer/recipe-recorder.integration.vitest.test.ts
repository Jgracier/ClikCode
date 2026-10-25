/** Auto-recorded recipe from real steps on a fake page, then replayed. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ToolContext } from '../tool-contract.js';
import { runSteps } from '../tools/computer-web.js';
import { beginJournal, recordVerified } from './recipe-recorder.js';
import { getRecipe, replayRecipe } from './signup-recipes.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
let browser: Browser | undefined;
beforeAll(async () => { if (enabled) browser = await chromium.launch({ channel: 'chrome', headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

it.skipIf(!enabled)('records the clicks (a page reference named by its text), then a replay on a fresh page reaches the key button', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-autorecipe-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<body><nav><a href="#" onclick="document.getElementById('a').hidden=true;document.getElementById('b').hidden=false;return false">Developer settings</a></nav>
      <div id="a">Home</div><div id="b" hidden><button id="k" onclick="document.title='made'">Create new key</button><input aria-label="Company"></div></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const ctx = { stateDir: dir } as unknown as ToolContext;
  try {
    const page = await browser!.newPage();
    await page.goto(url);
    beginJournal(`${dir}#t`, url);
    await runSteps(page, [{ do: 'click', target: 'Developer settings' }], ctx, 't');
    const snapshot = await page.ariaSnapshot({ mode: 'ai' } as never) as string;
    const ref = /button "Create new key" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    expect(ref).toBeTruthy();
    await runSteps(page, [{ do: 'click', target: ref! }], ctx, 't');
    expect(await page.title()).toBe('made');
    const saved = await recordVerified(dir, `${dir}#t`, { kind: 'capture', url: `${url}keys?x=1`, hint: 'Click "Create new key", then capture_secret.' });
    expect(saved?.steps).toEqual([{ do: 'click', target: 'Developer settings' }, { do: 'click', target: 'Create new key' }]);
    expect(await readFile(join(dir, 'computer', 'recipes', '127.0.0.1.json'), 'utf8')).not.toContain('ref=');

    const again = await browser!.newPage();
    await again.goto(url);
    const recipe = (await getRecipe(dir, '127.0.0.1'))!;
    const out = await replayRecipe(recipe, (steps, guard) => runSteps(again, steps, ctx, 'r', undefined, async () => guard()), async () => again.locator('body').innerText());
    expect(out.completed).toBe(true);
    expect(await again.title()).toBe('made');
  } finally { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); }
}, 60_000);
