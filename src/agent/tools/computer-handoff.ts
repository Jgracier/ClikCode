/** Temporarily hand the ClikCode browser to the same account on a phone. */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import Conf from 'conf';
import { defineTool } from '../tool-contract.js';
import { computerPage } from '../computer/browser.js';
import { computerEnabled } from '../computer/settings.js';
import { decryptAction, encryptPacket, type EncryptedPacket } from '../computer/handoff-crypto.js';
import { gatewayConnection } from '../models/for-session.js';
import { sniffImage } from '../images.js';
import type { Page } from 'playwright-core';

type Envelope<T> = { success?: boolean; data?: T };
const TEN_MINUTES = 10 * 60_000;

async function request<T>(url: string, apiKey: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({})) as Envelope<T> & { data?: { error?: string } };
  if (!response.ok || !result.success) throw new Error(result.data?.error ?? `Computer handoff request failed (${response.status}).`);
  return result.data as T;
}

async function applyPhoneAction(page: Page, action: ReturnType<typeof decryptAction>, width: number, height: number): Promise<void> {
  if (action.kind === 'click') {
    if (action.x >= width || action.y >= height) throw new Error('Click outside handoff image');
    await page.mouse.click(action.x, action.y);
  } else if (action.kind === 'type') await page.keyboard.insertText(action.text);
  else if (action.kind === 'key') await page.keyboard.press(action.key);
  else await page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
}

export const computerHandoffTool = defineTool<Record<string, never>>({
  name: 'computer_handoff', class: 'exec',
  description: 'When a browser site needs the user to solve a CAPTCHA, MFA or sign-in from another device, give them a short-lived link to control this exact browser from their phone. The agent waits and resumes when the user taps Done. Requires a ClikDeploy account connection and an open ClikCode browser.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Hand browser to user',
  async run(_args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: 'Computer use is off.', isError: true };
    let id: string | undefined;
    let url: string | undefined;
    let apiKey: string | undefined;
    try {
      await computerPage(ctx.stateDir);
      const connection = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
      apiKey = connection.apiKey;
      const origin = new URL(connection.baseUrl).origin;
      const root = `${origin}/api/clikcode/v1/computer`;
      const created = await request<{ id: string; expiresAt: number }>(root, apiKey, 'POST', {}, ctx.signal);
      id = created.id;
      const key = randomBytes(32);
      url = `${origin}/computer/handoff/${id}#key=${key.toString('base64url')}`;
      ctx.emitOutput?.(`Open this link on your phone to finish the browser step: ${url}\n`);
      const expiresAt = Math.min(created.expiresAt, Date.now() + TEN_MINUTES);
      let frameSeq = 0;
      let actionSeq = 0;
      let width = 0;
      let height = 0;
      while (Date.now() < expiresAt) {
        if (ctx.signal?.aborted) throw new Error('Handoff stopped.');
        const page = await computerPage(ctx.stateDir);
        let image = await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css', timeout: 10_000 });
        if (image.length > 1_000_000) image = await page.screenshot({ type: 'jpeg', quality: 25, scale: 'css', timeout: 10_000 });
        if (image.length > 1_000_000) throw new Error('Browser view is too large for phone handoff.');
        const size = sniffImage(image);
        if (!size?.width || !size.height) throw new Error('Could not size browser view.');
        width = size.width;
        height = size.height;
        await request(`${root}/${id}/frame`, apiKey, 'POST', encryptPacket(key, id, 'frame', ++frameSeq, image, { width, height }), ctx.signal);
        const next = await request<{ status: 'active' | 'done'; packet: EncryptedPacket | null }>(`${root}/${id}/action`, apiKey, 'GET', undefined, ctx.signal);
        if (next.status === 'done') return { output: 'The user finished the browser step. Continue the task from the current page.' };
        if (next.packet && next.packet.seq > actionSeq) {
          const action = decryptAction(key, id, next.packet);
          await applyPhoneAction(page, action, width, height);
          actionSeq = next.packet.seq;
        }
        await pause(900, undefined, { signal: ctx.signal });
      }
      return { output: 'The phone handoff expired after 10 minutes. Ask the user to try again if they still need it.', isError: true };
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
    finally { if (id && apiKey && url) await request(`${new URL(url).origin}/api/clikcode/v1/computer/${id}`, apiKey, 'DELETE').catch(() => undefined); }
  },
});
