import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  bind: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  closeOwned: vi.fn(),
  release: vi.fn(),
  consent: vi.fn(),
  email: vi.fn(),
}));

vi.mock('../agent/computer/browser.js', () => ({
  bindTabEgress: deps.bind,
  openNewComputerPage: deps.open,
  closeComputerPage: deps.close,
  closeOwnedPage: deps.closeOwned,
  releaseComputerBrowser: deps.release,
}));
vi.mock('../agent/computer/oauth-consent.js', () => ({
  oauthConnect: deps.consent,
  ConsentStop: class ConsentStop extends Error { detail?: unknown },
  pageExcerpt: (text: string) => text.slice(0, 100),
}));
vi.mock('../agent/computer/profiles.js', () => ({ profileEmail: deps.email }));

import { oauthConnectOutcome } from './computer-ops.js';

describe('OAuth browser setup cleanup', () => {
  const oldHome = process.env.CLIKCODE_HOME;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-connect-cleanup-'));
    process.env.CLIKCODE_HOME = dir;
    vi.clearAllMocks();
    deps.bind.mockResolvedValue(undefined);
    deps.open.mockResolvedValue({});
    deps.close.mockResolvedValue(undefined);
    deps.closeOwned.mockResolvedValue(undefined);
    deps.release.mockResolvedValue(undefined);
    deps.email.mockResolvedValue('agent@example.invalid');
    deps.consent.mockResolvedValue({ steps: [] });
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the browser if egress binding fails without closing an unopened tab', async () => {
    deps.bind.mockRejectedValue(new Error('egress unavailable'));

    await expect(oauthConnectOutcome('slack', { tab: 'oauth-test', egress: 'proxy' })).resolves.toMatchObject({
      ok: false,
      stop: { kind: 'unknown', message: 'egress unavailable' },
    });

    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it('closes the named tab and releases the browser when opening the OAuth page fails', async () => {
    deps.open.mockRejectedValue(new Error('browser startup failed'));

    await expect(oauthConnectOutcome('slack', { tab: 'oauth-test' })).resolves.toMatchObject({
      ok: false,
      stop: { kind: 'unknown', message: 'browser startup failed' },
    });

    expect(deps.close).toHaveBeenCalledOnce();
    expect(deps.close).toHaveBeenCalledWith(dir, 'oauth-test');
    expect(deps.release).toHaveBeenCalledOnce();
  });
});
