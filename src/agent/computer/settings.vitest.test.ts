import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { browserDisplay, browserProvider, computerEnabled, computerSettingsPath, generatedPasswordsAllowed, parseBrowserDisplay, setBrowserDisplay, setBrowserProvider, setComputerEnabled, setGeneratedPasswords } from './settings.js';

it('keeps each setting when the other is changed, and generated passwords are on until turned off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-settings-'));
  try {
    expect(await generatedPasswordsAllowed(dir)).toBe(true);
    await setGeneratedPasswords(dir, true);
    await setComputerEnabled(dir, false);
    expect(await generatedPasswordsAllowed(dir)).toBe(true);
    expect(await computerEnabled(dir)).toBe(false);
    await setGeneratedPasswords(dir, false);
    expect(await computerEnabled(dir)).toBe(false);
    expect(await generatedPasswordsAllowed(dir)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('keeps the browser display hidden until visible is asked for, beside the other settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-settings-'));
  try {
    expect(await browserDisplay(dir)).toBe('hidden');
    await setBrowserProvider(dir, 'auto');
    await setBrowserDisplay(dir, 'visible');
    expect(await browserDisplay(dir)).toBe('visible');
    expect(await browserProvider(dir)).toBe('auto');
    expect(JSON.parse(await readFile(computerSettingsPath(dir), 'utf8'))).toEqual({ browserProvider: 'auto', display: 'visible' });
    await setBrowserDisplay(dir, 'hidden');
    expect(await browserDisplay(dir)).toBe('hidden');
    // A value nobody wrote through the command is not a wish for a window.
    await mkdir(join(dir, 'computer'), { recursive: true });
    await writeFile(computerSettingsPath(dir), JSON.stringify({ display: 'yes' }));
    expect(await browserDisplay(dir)).toBe('hidden');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reads only visible and hidden as a display', () => {
  expect(parseBrowserDisplay('visible')).toBe('visible');
  expect(parseBrowserDisplay('hidden')).toBe('hidden');
  for (const other of ['on', 'Visible', '', undefined, true, 1]) expect(parseBrowserDisplay(other)).toBeUndefined();
});
