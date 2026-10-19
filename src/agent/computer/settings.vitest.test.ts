import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { computerEnabled, generatedPasswordsAllowed, setComputerEnabled, setGeneratedPasswords } from './settings.js';

it('keeps each setting when the other is changed, and generated passwords are off until turned on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-settings-'));
  try {
    expect(await generatedPasswordsAllowed(dir)).toBe(false);
    await setGeneratedPasswords(dir, true);
    await setComputerEnabled(dir, false);
    expect(await generatedPasswordsAllowed(dir)).toBe(true);
    expect(await computerEnabled(dir)).toBe(false);
    await setGeneratedPasswords(dir, false);
    expect(await computerEnabled(dir)).toBe(false);
    expect(await generatedPasswordsAllowed(dir)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
