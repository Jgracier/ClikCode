/** On macOS a process sees windows only from the logged-in desktop's launchd session (Aqua). ClikCode started over
 * SSH or Tailscale, or by a background job, is in the Background session; a cua-driver daemon it starts lands there
 * too and lists no windows even with every permission granted (measured on macOS 15.7: 0 windows from Background,
 * 15 from the same binary in gui/501). cua has no macOS autostart, so ClikCode starts the daemon in the desktop's
 * domain itself, as a launch agent that is loaded only for this login and never at the next one. */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DESKTOP_SERVICE_LABEL = 'com.clikcode.cua-driver';

const run = (command: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => execFile(command, args, { timeout: timeoutMs }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })));

export type DesktopServiceStep = 'none' | 'kickstart' | 'bootstrap';

/** What to do before connecting: nothing inside the desktop session or with no one logged in at the screen,
 * start the agent again when it is loaded but stopped, else load it (after stopping a daemon from the wrong session). */
export function desktopServiceStep(state: { platform: NodeJS.Platform; session: string; desktopDomain: boolean; loaded: boolean; running: boolean }): DesktopServiceStep {
  if (state.platform !== 'darwin' || state.session === 'Aqua' || !state.desktopDomain) return 'none';
  if (state.running) return 'none';
  return state.loaded ? 'kickstart' : 'bootstrap';
}

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function desktopServicePlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${DESKTOP_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>serve</string></array>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
}

const daemonSocket = (): string => join(homedir(), 'Library', 'Caches', 'cua-driver', 'cua-driver.sock');

/** Make sure the cua-driver daemon runs in the desktop session (macOS only; a no-op elsewhere and inside it).
 * Never throws: when it cannot, cua starts its own daemon as before. */
export async function ensureDesktopDriverService(binary: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin' || !binary.startsWith('/')) return;
  try {
    const session = (await run('launchctl', ['managername'])).stdout.trim();
    if (session === 'Aqua') return;
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const domain = `gui/${uid}`;
    const desktopDomain = (await run('launchctl', ['print', domain])).ok;
    const job = await run('launchctl', ['print', `${domain}/${DESKTOP_SERVICE_LABEL}`]);
    const step = desktopServiceStep({ platform, session, desktopDomain, loaded: job.ok, running: /\bstate = running\b/.test(job.stdout) });
    if (step === 'none') return;
    // Through a symlink (~/.local/bin/cua-driver) cua relaunches itself from CuaDriver.app and leaves the first process
    // behind; the app's own path gives one daemon, with the app's permissions.
    const program = realpathSync(binary);
    // A daemon this session started holds the socket and sees no windows: stop it so the desktop one can listen.
    await run(program, ['stop'], 15_000);
    if (step === 'kickstart') await run('launchctl', ['kickstart', `${domain}/${DESKTOP_SERVICE_LABEL}`]);
    else {
      const plist = join(homedir(), '.clikcode', 'computer', `${DESKTOP_SERVICE_LABEL}.plist`);
      await mkdir(dirname(plist), { recursive: true, mode: 0o700 });
      await writeFile(plist, desktopServicePlist(program), { mode: 0o600 });
      await run('launchctl', ['bootstrap', domain, plist]);
    }
    for (let waited = 0; waited < 8_000 && !existsSync(daemonSocket()); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  } catch { /* cua falls back to starting its own daemon */ }
}
