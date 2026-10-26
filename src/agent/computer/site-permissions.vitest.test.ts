import { expect, it } from 'vitest';
import { parsePermissions, permissionOrigin } from './site-permissions.js';

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
