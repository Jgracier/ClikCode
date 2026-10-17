import { expect, it } from 'vitest';

it('ranks a secret above a key above plain, and an id last', async () => {
  const { copyRank } = await import('./clipboard-watch.js');
  expect(copyRank('Secret Key:7456')).toBeGreaterThan(copyRank('Api key'));
  expect(copyRank('Api key')).toBeGreaterThan(copyRank('Copy'));
  expect(copyRank('Copy')).toBeGreaterThan(copyRank('Access Key ID:SCW1'));
});
