/** Shared by the integration suites: waiting on the chat's state, driving
 * its page, and screenshots. */
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { ClikCodeApi } from '../../../src/extension';
import type { ChatModel } from '../../../src/model';

export function until(
  source: { state: ChatModel; onDidChange: vscode.Event<ChatModel> }, test: (model: ChatModel) => boolean, what: string, timeoutMs = 60_000,
): Promise<ChatModel> {
  if (test(source.state)) return Promise.resolve(source.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`timed out waiting for ${what}; state: ${JSON.stringify({ ...source.state, messages: source.state.messages.slice(-3) }).slice(0, 2500)}`));
    }, timeoutMs);
    const listener = source.onDidChange((model) => {
      if (!test(model)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(model);
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Found { count: number; text: string; texts: string[]; disabled: boolean }

export async function query(api: ClikCodeApi, selector: string): Promise<Found> {
  return await api.probe('query', selector) as Found;
}

/** Waits for the page to show something matching `selector`. */
export async function waitFor(api: ClikCodeApi, selector: string, what = selector, timeoutMs = 90_000, test: (found: Found) => boolean = (found) => found.count > 0): Promise<Found> {
  const deadline = Date.now() + timeoutMs;
  let last: Found | undefined;
  for (;;) {
    try { last = await query(api, selector); } catch { last = undefined; }
    if (last && test(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await sleep(250);
  }
}

export async function click(api: ClikCodeApi, selector: string): Promise<void> {
  const result = await api.probe('click', selector) as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(result.error);
}

export async function type(api: ClikCodeApi, selector: string, text: string): Promise<void> {
  const result = await api.probe('type', selector, text) as { ok: boolean; error?: string };
  if (!result.ok) throw new Error(result.error);
}

export async function key(api: ClikCodeApi, selector: string, name: string): Promise<void> {
  await api.probe('key', selector, name);
}

/** The whole screen, when a display is there to capture (xwd under xvfb). */
export async function screenshot(name: string, settle = 1_200): Promise<void> {
  const dir = process.env.CLIKCODE_IT_SCREENSHOT_DIR;
  if (!dir) return;
  await sleep(settle);
  const theme = process.env.CLIKCODE_IT_THEME ?? 'dark';
  // The X server's framebuffer as it is on screen (xwd -root can read the
  // root window's own, blank, contents under a bare Xvfb).
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-i', process.env.DISPLAY ?? ':99', '-frames:v', '1', `${dir}/${name}-${theme}.png`], { timeout: 20_000 });
  } catch {
    try { execFileSync('xwd', ['-root', '-silent', '-out', `${dir}/${name}-${theme}.xwd`]); } catch { /* optional */ }
  }
}

export async function activate(): Promise<ClikCodeApi> {
  const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'clikcode');
  if (!extension) throw new Error('the extension is not installed in the test instance');
  return await extension.activate() as ClikCodeApi;
}

/** The composer's provider·model menu, at its list of providers (it opens
 * on the current provider's models). */
export async function openProviderList(api: ClikCodeApi): Promise<void> {
  if (!(await query(api, '#provider-picker')).count) await click(api, '#provider-button');
  await waitFor(api, '#provider-picker', 'the provider menu');
  if ((await query(api, '#picker-back')).count) await click(api, '#picker-back');
  await waitFor(api, '#provider-picker [data-key^="p:"]', 'the provider list');
}

/** Chooses a provider and model the way a user does: the composer's
 * provider·model menu, search, the provider, then the model. */
export async function pickProviderModel(api: ClikCodeApi, provider: string, model: string, beforeChoosing?: () => Promise<void>): Promise<void> {
  await openProviderList(api);
  await type(api, '#provider-picker input', provider);
  await waitFor(api, `#provider-picker [data-key="p:${provider}"]`, `the ${provider} row`);
  await click(api, `#provider-picker [data-key="p:${provider}"]`);
  await waitFor(api, `#provider-picker [data-key="m:${model}"]`, `the ${model} model`, 120_000);
  await type(api, '#provider-picker input', model.split('/').pop()!);
  await waitFor(api, `#provider-picker [data-key="m:${model}"]`, `the ${model} model after search`);
  if (beforeChoosing) await beforeChoosing();
  await click(api, `#provider-picker [data-key="m:${model}"]`);
}
