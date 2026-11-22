import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { denyByDefault, describePermissions, parsePermissions, permissionOrigin, setSitePermissions } from './site-permissions.js';

it('reads permission names from a list or from words', () => {
  expect(parsePermissions(['camera', 'Microphone', 'camera'])).toEqual(['camera', 'microphone']);
  expect(parsePermissions('geolocation, clipboard notifications')).toEqual(['geolocation', 'clipboard', 'notifications']);
  expect(parsePermissions(undefined)).toEqual([]);
  expect(() => parsePermissions(['camera', 'usb'])).toThrow(/Unknown permission usb/);
});

it('works on website origins only', () => {
  expect(permissionOrigin('https://example.com/a/b?c=1')).toBe('https://example.com');
  expect(() => permissionOrigin('about:blank')).toThrow(/website origin/);
  expect(() => permissionOrigin('file:///etc/passwd')).toThrow(/website origin/);
});

describe('per browser context', () => {
  /** Two tabs Playwright files under one context (an egress tab the browser host opened is so), in different Chrome contexts. */
  function tabs() {
    const sent: Array<Record<string, unknown>> = [];
    const browserSession = { send: vi.fn(async (_method: string, params: Record<string, unknown>) => { sent.push(params); return {}; }) };
    const browser = { newBrowserCDPSession: vi.fn(async () => browserSession) };
    const pageIn = (contextId: string): Page => {
      const page = {} as Page;
      const context = { browser: () => browser, newCDPSession: async () => ({ send: async () => ({ targetInfo: { browserContextId: contextId } }), detach: async () => undefined }) };
      Object.assign(page, { context: () => context });
      return page;
    };
    return { sent, home: pageIn('HOME-CTX'), egress: pageIn('EGRESS-CTX') };
  }

  it('sets a rule in the tab\'s own Chrome context and keeps decisions apart', async () => {
    const { sent, home, egress } = tabs();
    await setSitePermissions(egress, 'https://site.test', { grant: ['camera'] });
    expect(sent).toEqual([{ permission: { name: 'camera' }, setting: 'granted', origin: 'https://site.test', browserContextId: 'EGRESS-CTX' }]);
    sent.length = 0;
    await denyByDefault(home, 'https://site.test');
    expect(sent.map(item => item.browserContextId)).toEqual(Array(6).fill('HOME-CTX'));
    expect(sent.map(item => (item.permission as { name: string }).name)).toContain('camera');
    expect(await describePermissions(egress, 'https://site.test')).toContain('camera granted');
    expect(await describePermissions(home, 'https://site.test')).not.toContain('camera granted');
  });
});
