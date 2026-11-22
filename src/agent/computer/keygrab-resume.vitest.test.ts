import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const calls: { reattach: string[]; live: Array<Record<string, unknown>> } = { reattach: [], live: [] };
vi.mock('./browser.js', () => ({
  reattachParkedPage: async (_dir: string, tab: string) => { calls.reattach.push(tab); return true; },
  openComputerPage: async () => undefined, parkComputerPage: async () => true, releaseComputerBrowser: async () => undefined,
}));
vi.mock('./keygrab-live.js', () => ({
  DEFAULT_TAB: 'keygrab',
  liveKeygrabPort: async () => ({}),
  liveKeygrab: async (options: Record<string, unknown>) => { calls.live.push(options); return { ok: true, note: 'captured' }; },
}));

const { saveParked } = await import('./keygrab-park.js');
const { resumeKeygrab } = await import('./keygrab-resume.js');

let dir = '';
afterEach(async () => { calls.reattach = []; calls.live = []; if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

it('a resumed keygrab reattaches the run\'s own tab and delivers where the first run was asked to', async () => {
  dir = await mkdtemp(join(tmpdir(), 'kg-resume-'));
  const delivery = { secretName: 'acme/admin-key', keyName: 'CI', sendTo: [{ to: 'clikdeploy-secret', with: { key: 'ACME_KEY' } }] };
  await saveParked(dir, { id: 'acme', marker: 'clikcode-keygrab:acme', parkedAt: '2026-11-21T00:00:00Z', url: 'https://acme.example/keys', vendorUrl: 'https://acme.example/', trail: [], controls: [], visited: [], menus: [], why: 'captcha', tab: 'chat-7', delivery });
  await resumeKeygrab({ stateDir: dir, id: 'acme' });
  expect(calls.reattach).toEqual(['chat-7']);
  expect(calls.live[0]).toMatchObject({ tab: 'chat-7', delivery });
  // A caller that names its own delivery wins.
  const mine = { secretName: 'acme/other' };
  await resumeKeygrab({ stateDir: dir, id: 'acme', delivery: mine });
  expect(calls.live[1]).toMatchObject({ delivery: mine });
});
