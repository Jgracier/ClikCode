/** The tab's environment: its size and device (a phone, a tablet, a window of a given size), where and when it
 * thinks it is (location, time zone, language), a PDF of the page, and the site's cookies (names only).
 * Emulation is set over the DevTools protocol on one session per tab; Chrome drops it when that session closes, so
 * it lasts while the tab and this connection do. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { downloadsDir, freeName, safeFileName, sizeText } from './downloads.js';
import { sharedState } from './shared-state.js';

export type DeviceArgs = {
  width?: number; height?: number; scale?: number; mobile?: boolean; device?: string; reset?: boolean;
  geolocation?: { latitude: number; longitude: number; accuracy?: number } | string; timezone?: string; locale?: string;
};

export type DevicePreset = { userAgent: string; viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean };

type State = { session: Promise<CDPSession>; description: string[] };
const states = sharedState('page-environment', () => new WeakMap<Page, State>());

async function sessionFor(page: Page): Promise<CDPSession> {
  let state = states.get(page);
  if (!state) {
    state = { session: page.context().newCDPSession(page), description: [] };
    states.set(page, state);
    state.session.catch(() => states.delete(page));
    page.once('close', () => states.delete(page));
  }
  return state.session;
}

/** A device from Playwright's list by name, ignoring case, spaces and punctuation ("iphone15" finds "iPhone 15"). */
export function findDevice(name: string, devices: Readonly<Record<string, DevicePreset>>): { name: string; preset: DevicePreset } {
  const key = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = key(name);
  const names = Object.keys(devices).filter(device => !/landscape$/i.test(device) || /landscape/i.test(name));
  const exact = names.find(device => key(device) === wanted);
  const found = exact ?? names.find(device => key(device).startsWith(wanted)) ?? names.find(device => key(device).includes(wanted));
  if (!found) {
    const nearby = names.filter(device => /iphone|pixel|ipad|galaxy/i.test(device)).slice(-12);
    throw new Error(`No device called "${name}". Some that exist: ${nearby.join(', ')}.`);
  }
  return { name: found, preset: devices[found]! };
}

function checkNumber(value: number | undefined, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number from ${min} to ${max}.`);
  return Math.round(value * 100) / 100;
}

export function parseGeolocation(value: DeviceArgs['geolocation']): { latitude: number; longitude: number; accuracy: number } | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? (/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value)?.slice(1, 3).map(Number) ?? []) : [value.latitude, value.longitude];
  const [latitude, longitude] = raw;
  if (latitude === undefined || longitude === undefined || !(latitude >= -90 && latitude <= 90) || !(longitude >= -180 && longitude <= 180)) throw new Error('geolocation needs a latitude (-90 to 90) and a longitude (-180 to 180), e.g. {latitude: 48.85, longitude: 2.35}.');
  const accuracy = typeof value === 'object' && value.accuracy !== undefined ? value.accuracy : 50;
  return { latitude, longitude, accuracy: checkNumber(accuracy, 'accuracy', 0, 100_000)! };
}

export function checkTimezone(zone: string): string {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; }
  catch { throw new Error(`"${zone}" is not a time zone. Use an IANA name such as Europe/Paris or America/New_York.`); }
}

export function checkLocale(locale: string): string {
  try { return Intl.getCanonicalLocales(locale)[0]!; }
  catch { throw new Error(`"${locale}" is not a language tag. Use one such as en-US, fr-FR or ja-JP.`); }
}

/** Applies size, device, location, time zone and language to the tab; returns what is now in force. */
export async function emulate(page: Page, args: DeviceArgs, devices: Readonly<Record<string, DevicePreset>>): Promise<string> {
  const session = await sessionFor(page);
  const state = states.get(page)!;
  if (args.reset) {
    await session.send('Emulation.clearDeviceMetricsOverride');
    await session.send('Emulation.setUserAgentOverride', { userAgent: '' });
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await session.send('Emulation.clearGeolocationOverride');
    await session.send('Emulation.setTimezoneOverride', { timezoneId: '' });
    await session.send('Emulation.setLocaleOverride', { locale: '' });
    state.description = [];
    return 'Back to the real window size, device, location, time zone and language.';
  }
  const said: string[] = [];
  let width = checkNumber(args.width, 'width', 100, 10_000);
  let height = checkNumber(args.height, 'height', 100, 10_000);
  let scale = checkNumber(args.scale, 'scale', 0.5, 10);
  let mobile = args.mobile;
  if (args.device) {
    const { name, preset } = findDevice(args.device, devices);
    width ??= preset.viewport.width; height ??= preset.viewport.height; scale ??= preset.deviceScaleFactor; mobile ??= preset.isMobile;
    await session.send('Emulation.setUserAgentOverride', { userAgent: preset.userAgent });
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: preset.hasTouch, maxTouchPoints: preset.hasTouch ? 5 : 1 });
    said.push(`device ${name}`);
  } else if (mobile !== undefined) await session.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  if (width !== undefined || height !== undefined || scale !== undefined || mobile !== undefined) {
    const size = await page.evaluate(() => { const g = globalThis as unknown as { innerWidth: number; innerHeight: number }; return { width: g.innerWidth, height: g.innerHeight }; });
    width ??= size.width; height ??= size.height;
    await session.send('Emulation.setDeviceMetricsOverride', { width: Math.round(width), height: Math.round(height), deviceScaleFactor: scale ?? 0, mobile: mobile ?? false });
    said.push(`${Math.round(width)}x${Math.round(height)}${scale ? ` at ${scale}x` : ''}${mobile ? ' as a phone/tablet (mobile, touch)' : ''}`);
  }
  const geolocation = parseGeolocation(args.geolocation);
  if (geolocation) { await session.send('Emulation.setGeolocationOverride', geolocation); said.push(`location ${geolocation.latitude}, ${geolocation.longitude}`); }
  if (args.timezone) { await session.send('Emulation.setTimezoneOverride', { timezoneId: checkTimezone(args.timezone) }); said.push(`time zone ${args.timezone}`); }
  if (args.locale) {
    const locale = checkLocale(args.locale);
    await session.send('Emulation.setLocaleOverride', { locale });
    // The Accept-Language header follows, so the site is served in that language.
    await session.send('Emulation.setUserAgentOverride', { userAgent: await page.evaluate(() => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent), acceptLanguage: locale }).catch(quiet('agent/computer/page-environment'));
    said.push(`language ${locale}`);
  }
  if (!said.length) return state.description.length ? `In force: ${state.description.join('; ')}.` : 'Nothing is emulated: the tab has its real size, location, time zone and language. Give width/height/scale/mobile, a device, geolocation, timezone or locale.';
  state.description = [...state.description.filter(old => !said.some(item => item.split(' ')[0] === old.split(' ')[0])), ...said];
  return `Set ${said.join('; ')}.${args.geolocation ? ' (A site can only read the location once geolocation is allowed: permissions grant.)' : ''}${args.device || args.locale ? ' Reload the page for the site to see the new user agent or language.' : ''}`;
}

// ── PDF of the page ─────────────────────────────────────────────────────────

export async function printPdf(page: Page, stateDir: string, chat: string | undefined, options: { landscape?: boolean; file_name?: string } = {}): Promise<string> {
  const session = await sessionFor(page);
  let data: string;
  try { ({ data } = await session.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, landscape: options.landscape === true })); }
  catch (error) { throw new Error(`The browser could not print this page to a PDF (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Printing needs a Chrome that supports it; headless mode (clikcode computer headless on) always does.`); }
  const dir = downloadsDir(stateDir, chat);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const title = (await page.title().catch(() => '')) || new URL(page.url()).hostname || 'page';
  const wanted = safeFileName(options.file_name?.trim() || title).replace(/\.pdf$/i, '');
  const file = await freeName(dir, `${wanted}.pdf`);
  await fs.writeFile(file, Buffer.from(data, 'base64'), { mode: 0o600 });
  return `Saved the page as a PDF: ${path.basename(file)} (${sizeText((await fs.stat(file)).size)}) at ${file}.`;
}

// ── cookies ─────────────────────────────────────────────────────────────────

const when = (expires: number): string => expires > 0 ? new Date(expires * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'session';

/** The site's cookies by name, domain and expiry (never the values), or removes them. */
export async function siteCookies(page: Page, options: { url?: string; clear?: boolean } = {}): Promise<string> {
  const url = options.url ?? page.url();
  let site: URL;
  try { site = new URL(url); } catch { throw new Error('Cookies belong to a website: open one first.'); }
  if (!/^https?:$/.test(site.protocol)) throw new Error('Cookies belong to a website: open one first.');
  const cookies = await page.context().cookies(site.href);
  if (options.clear) {
    for (const cookie of cookies) await page.context().clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    return cookies.length ? `Removed ${cookies.length} cookie${cookies.length === 1 ? '' : 's'} for ${site.hostname}. Reload the page; a site that kept you signed in with them will ask again.` : `${site.hostname} had no cookies.`;
  }
  if (!cookies.length) return `${site.hostname} has no cookies.`;
  const rows = cookies.slice(0, 80).map(cookie => `- ${cookie.name} (${cookie.domain}${cookie.path}) expires ${when(cookie.expires)}${cookie.httpOnly ? ', httpOnly' : ''}${cookie.secure ? ', secure' : ''}${cookie.sameSite && cookie.sameSite !== 'None' ? `, SameSite=${cookie.sameSite}` : ''}`);
  return `${cookies.length} cookie${cookies.length === 1 ? '' : 's'} for ${site.hostname} (values are not shown):\n${rows.join('\n')}${cookies.length > 80 ? `\n(… ${cookies.length - 80} more)` : ''}`;
}
