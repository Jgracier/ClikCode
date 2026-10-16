import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  password: 'top-secret',
  driver: vi.fn(async () => ({ isError: false })),
  front: vi.fn(async () => undefined),
}));
vi.mock('../computer/browser.js', () => ({ computerPage: async () => ({
  locator: () => ({ first: () => ({ count: async () => 1, inputValue: async () => mock.password }) }),
  bringToFront: mock.front, waitForTimeout: async () => undefined,
  context: () => ({ close: vi.fn() }),
}) }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));
vi.mock('../computer/driver.js', () => ({ callComputerDriver: mock.driver }));

import { computerWebTool } from './computer-web.js';
import type { ToolContext } from '../tool-contract.js';

it('triggers the installed password manager from the browser without returning the password', async () => {
  const result = await computerWebTool.run({ action: 'autofill' }, { stateDir: '/tmp/clikcode-test' } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('Bitwarden filled');
  expect(result.output).not.toContain(mock.password);
  expect(mock.front).toHaveBeenCalled();
  expect(mock.driver).toHaveBeenCalledWith('hotkey', {
    scope: 'desktop', target: { kind: 'desktop', display_id: 'primary' }, keys: ['ctrl', 'shift', 'l'],
  }, undefined);
});

it('reports when no password was filled', async () => {
  mock.password = '';
  const result = await computerWebTool.run({ action: 'autofill' }, { stateDir: '/tmp/clikcode-test' } as ToolContext);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('did not fill');
});
