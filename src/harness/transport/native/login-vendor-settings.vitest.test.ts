import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeVendorSettings } from './login.js';

describe('a pasted key\'s vendor setting', () => {
  it('is added to the vendor\'s settings, keeping what is there', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'cc-vendor-settings-')), 'settings.json');
    await writeFile(file, '{"theme":"dark"}', 'utf8');
    await mergeVendorSettings('Antigravity CLI', file, { modelProvider: 'gemini' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'dark', modelProvider: 'gemini' });
  });

  it('never rewrites a settings file it cannot read, and says which file', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'cc-vendor-settings-')), 'settings.json');
    const text = '{\n  // the user\'s own comment\n  "theme": "dark"\n}\n';
    await writeFile(file, text, 'utf8');
    await expect(mergeVendorSettings('Antigravity CLI', file, { modelProvider: 'gemini' })).rejects.toThrow(file);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
});
