import { expect, it, vi } from 'vitest';
import type { ToolContext } from '../tool-contract.js';

const mock = vi.hoisted(() => ({ request: vi.fn(), fill: vi.fn(async () => undefined) }));
vi.mock('../computer/browser.js', () => ({ computerPage: async () => ({ url: () => 'https://accounts.google.com/signin/v2/identifier' }) }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));
vi.mock('../computer/credential-vault.js', () => ({ fillCredential: mock.fill, CredentialError: class CredentialError extends Error {} }));
vi.mock('../computer/tailcat-credentials.js', () => ({ requestTailcatCredential: mock.request }));
import { computerCredentialsTool } from './computer-credentials.js';

it('offers a private account-free link and returns only the saved login reference', async () => {
  mock.request.mockImplementationOnce(async ({ onLink }: { onLink(link: string): void }) => {
    onLink('https://jgracier.github.io/ClikCode/handoff/#mode=credential&token=private');
    return '11111111-1111-4111-8111-111111111111';
  });
  const output: string[] = [];
  const result = await computerCredentialsTool.run({ action: 'request' }, {
    stateDir: '/tmp/credential-test', emitOutput: text => output.push(text),
  } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(output).toEqual([expect.stringContaining('mode=credential')]);
  expect(result.output).toContain('11111111-1111-4111-8111-111111111111');
  expect(result.output).not.toContain('token=private');
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ site: 'https://accounts.google.com' }));
});

it('fills a saved login without a network request', async () => {
  const result = await computerCredentialsTool.run({ action: 'fill', item_id: '11111111-1111-4111-8111-111111111111' }, {
    stateDir: '/tmp/credential-test',
  } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(mock.fill).toHaveBeenCalled();
  expect(result.output).not.toContain('secret');
});
