/** The glue between browser_use's files-and-environment actions and the modules behind them. computer-web.ts only
 * calls these; they return plain text (the caller adds the page view where one is wanted). */
import type { Page } from 'playwright-core';
import type { ToolContext } from '../tool-contract.js';
import { disableHttpAuth, enableHttpAuth, httpAuthOrigin, httpCredentialsFor } from './http-auth.js';

export type EnvArgs = { label?: string; http_auth?: boolean | string; clear?: boolean };

/** Turns on HTTP Basic/Digest sign-in for the origin of `url`, using its saved login. Never returns the credentials. */
export async function applyHttpAuth(page: Page, url: string, args: EnvArgs, ctx: ToolContext): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('HTTP sign-in sends the username and password with every request, so it is only used on https sites.');
  const label = typeof args.http_auth === 'string' ? args.http_auth : args.label;
  const credentials = await httpCredentialsFor(ctx.stateDir, url, {
    ...(label ? { label } : {}),
    ...(ctx.requestPrivateLogin ? { ask: (site, fields) => ctx.requestPrivateLogin!(site, fields, ctx.signal) } : {}),
  });
  if (!credentials) throw new Error(`No saved login for ${parsed.origin} and this chat cannot ask the user privately. The user can sign in to the site once with the login action, or save one with: clikcode computer secrets --import`);
  await enableHttpAuth(page, parsed.origin, credentials);
  return `HTTP sign-in is on for ${parsed.origin} in this tab, using the saved login (the username and password are not shown). If the site still answers 401, the saved login is wrong: forget_login it and try again.`;
}

export async function clearHttpAuth(page: Page): Promise<string> {
  const origin = httpAuthOrigin(page);
  return await disableHttpAuth(page) ? `HTTP sign-in for ${origin} is off for this tab.` : 'HTTP sign-in was not on for this tab.';
}
