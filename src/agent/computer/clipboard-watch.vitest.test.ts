import { expect, it } from 'vitest';

it('ranks a secret above a key above plain, and an id last', async () => {
  const { copyRank } = await import('./clipboard-watch.js');
  expect(copyRank('Secret Key:7456')).toBeGreaterThan(copyRank('Api key'));
  expect(copyRank('Api key')).toBeGreaterThan(copyRank('Copy'));
  expect(copyRank('Copy')).toBeGreaterThan(copyRank('Access Key ID:SCW1'));
});

it('takes the real wordings of a credential Copy button and not a button that copies something else', async () => {
  const { COPY_KEY_BUTTON, COPIES_OTHER } = await import('./clipboard-watch.js');
  const takes = (name: string): boolean => COPY_KEY_BUTTON.test(name) && !COPIES_OTHER.test(name);
  for (const name of ['Copy', 'Copy client secret', 'Copy client secret to clipboard', 'Copy and close', 'Copy API key', 'Copy to clipboard']) expect(takes(name), name).toBe(true);
  for (const name of ['Copy client ID', 'Copy cURL command', 'Copy link', 'Copy email address']) expect(takes(name), name).toBe(false);
});
