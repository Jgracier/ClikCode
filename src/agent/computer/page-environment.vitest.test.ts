import { expect, it } from 'vitest';
import { checkLocale, checkTimezone, findDevice, parseGeolocation, type DevicePreset } from './page-environment.js';

const preset = (width: number): DevicePreset => ({ userAgent: 'UA', viewport: { width, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const devices = { 'iPhone 15': preset(393), 'iPhone 15 landscape': preset(659), 'iPhone 15 Pro Max': preset(430), 'Pixel 7': preset(412), 'Desktop Chrome': { ...preset(1280), isMobile: false } };

it('finds a device by a loose name', () => {
  expect(findDevice('iPhone 15', devices).name).toBe('iPhone 15');
  expect(findDevice('iphone15', devices).name).toBe('iPhone 15');
  expect(findDevice('pixel 7', devices).name).toBe('Pixel 7');
  expect(findDevice('iPhone 15 landscape', devices).name).toBe('iPhone 15 landscape');
  expect(findDevice('iPhone 15 pro', devices).name).toBe('iPhone 15 Pro Max');
  expect(() => findDevice('Nokia 3310', devices)).toThrow(/No device called "Nokia 3310".*iPhone 15/);
});

it('reads a location as an object or as "lat,lon"', () => {
  expect(parseGeolocation({ latitude: 48.85, longitude: 2.35 })).toEqual({ latitude: 48.85, longitude: 2.35, accuracy: 50 });
  expect(parseGeolocation('48.85, 2.35')).toEqual({ latitude: 48.85, longitude: 2.35, accuracy: 50 });
  expect(parseGeolocation('-33.9 151.2')).toEqual({ latitude: -33.9, longitude: 151.2, accuracy: 50 });
  expect(parseGeolocation(undefined)).toBeUndefined();
  expect(() => parseGeolocation({ latitude: 95, longitude: 0 })).toThrow(/latitude/);
  expect(() => parseGeolocation('somewhere')).toThrow(/latitude/);
});

it('checks time zones and languages', () => {
  expect(checkTimezone('Europe/Paris')).toBe('Europe/Paris');
  expect(() => checkTimezone('Mars/Olympus')).toThrow(/not a time zone/);
  expect(checkLocale('fr-fr')).toBe('fr-FR');
  expect(() => checkLocale('not a locale!')).toThrow(/not a language tag/);
});
