import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownKeyPagesFor, siteOf } from './keygrab-live.js';
import { saveRecipe } from './signup-recipes.js';

describe('key pages known for a site', () => {
  it('reads a host as its site', () => {
    expect(siteOf('1console.twilio.com')).toBe('twilio.com');
    expect(siteOf('www.twilio.com')).toBe('twilio.com');
    expect(siteOf('app.example.co.uk')).toBe('example.co.uk');
  });
  it('offers the key pages saved recipes recorded on the same site, and none from another', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kp-'));
    try {
      await saveRecipe(dir, { host: '1console.twilio.com', loginRoute: 'email', steps: [{ do: 'click', target: 'Create API key' }], keyPage: 'https://1console.twilio.com/account/AC1/settings/us1/api-keys/list' });
      await saveRecipe(dir, { host: 'other.example', loginRoute: 'email', steps: [{ do: 'click', target: 'x' }], keyPage: 'https://other.example/keys' });
      expect(await knownKeyPagesFor(dir, ['https://www.twilio.com/en-us'])).toEqual(['https://1console.twilio.com/account/AC1/settings/us1/api-keys/list']);
      expect(await knownKeyPagesFor(dir, ['https://nothing.example/'])).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
