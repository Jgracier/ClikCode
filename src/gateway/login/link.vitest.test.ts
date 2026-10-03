import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseLoginLink, extractLoginCode, runLinkLogin, type LoginLink } from './link.js';
import { extractLoginUrl } from './url.js';

describe('reading a link sign-in', () => {
  it('reads the code each vendor prints, as confirmed from their real logins', () => {
    expect(extractLoginCode('To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG\nConfirm this code in your browser:\n  5FCB-TTXG')).toBe('5FCB-TTXG');
    expect(extractLoginCode('2. Enter this one-time code (expires in 15 minutes)\n   CRLB-RHOR1')).toBe('CRLB-RHOR1');
    expect(extractLoginCode('To authenticate, visit https://github.com/login/device and enter code 3513-924C')).toBe('3513-924C');
    expect(extractLoginCode('', 'https://app.all-hands.dev/oauth/device/verify?user_code=3EQTT6UN')).toBe('3EQTT6UN');
    expect(extractLoginCode('Opening your browser to authenticate...')).toBeUndefined();
  });

  it('finds sign-in links whose path names no auth word on a boundary', () => {
    expect(extractLoginUrl('Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=TUD5-HVED'))
      .toBe('https://www.kimi.ai/code/authorize_device?user_code=TUD5-HVED');
    expect(extractLoginUrl('docs at https://example.com/guide')).toBeUndefined();
  });

  it('prefers the link the vendor tried to open where a browser is local, the printed one where none is', () => {
    expect(chooseLoginLink({ printed: 'https://p', opened: 'https://o', local: true })).toBe('https://o');
    expect(chooseLoginLink({ printed: 'https://p', opened: 'https://o', local: false })).toBe('https://p');
    expect(chooseLoginLink({ opened: 'https://o', local: false })).toBe('https://o');
  });
});

describe.skipIf(process.platform === 'win32')('running a link sign-in', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-link-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** A stand-in vendor: prints a device link and code, asks the desktop to
   * open a link of its own, then waits `wait` seconds and exits `status`. */
  const vendor = async (status: number, wait = 0.5): Promise<string> => {
    const path = join(dir, 'vendor');
    await writeFile(path, `#!/bin/sh
[ -t 0 ] && [ -t 1 ] || { echo "not a tty"; exit 9; }
echo "To sign in, open this URL in your browser:"
echo "  https://accounts.example/oauth2/device?user_code=AB12-CD34"
xdg-open "https://accounts.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455"
sleep ${wait}
echo "done"
exit ${status}
`);
    await chmod(path, 0o755);
    return path;
  };

  it('shows the link and code once, never opens a browser itself, and resolves when the vendor signs in', async () => {
    const shown: LoginLink[] = [];
    await runLinkLogin({ binary: await vendor(0), args: [], env: {}, displayName: 'Example', local: false, show: (link) => shown.push(link) });
    expect(shown).toEqual([{ url: 'https://accounts.example/oauth2/device?user_code=AB12-CD34', code: 'AB12-CD34' }]);
  });

  it('shows the link the vendor tried to open where a browser is local', async () => {
    const shown: LoginLink[] = [];
    await runLinkLogin({ binary: await vendor(0, 1), args: [], env: {}, displayName: 'Example', local: true, show: (link) => shown.push(link) });
    expect(shown.at(-1)?.url).toBe('https://accounts.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455');
  });

  it('says what the vendor said when its sign-in fails', async () => {
    await expect(runLinkLogin({ binary: await vendor(3), args: [], env: {}, displayName: 'Example', local: false, show: () => undefined }))
      .rejects.toThrow(/Example sign-in exited with status 3: done/);
  });

  it('stops the vendor when cancelled', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const login = runLinkLogin({
      binary: await vendor(0, 30), args: [], env: {}, displayName: 'Example', local: false,
      show: () => controller.abort(), signal: controller.signal,
    });
    await expect(login).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
