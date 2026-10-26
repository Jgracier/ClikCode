/** Cua's optional GNOME Shell helper ("winrects@cua"): window geometry and the agent cursor on Mutter Wayland.
 * It is a Shell extension, so it loads only at the next log-in, and Cua disabled it on GNOME 50 where it crashed the
 * Shell. This only decides whether running its bundled installer is sensible; nothing here runs it by itself. */

export const HELPER_MIN_GNOME = 45;
export const HELPER_MAX_GNOME = 49;

/** The major version in `gnome-shell --version` output ("GNOME Shell 49.2"). */
export function gnomeMajor(versionOutput: string): number | undefined {
  const major = versionOutput.match(/GNOME Shell\s+(\d+)/i)?.[1];
  return major === undefined ? undefined : Number(major);
}

export type HelperVerdict = { ok: true; major: number } | { ok: false; reason: string };

export function waylandHelperVerdict(input: { platform: NodeJS.Platform; desktop?: string; sessionType?: string; gnomeShellOutput?: string }): HelperVerdict {
  if (input.platform !== 'linux') return { ok: false, reason: 'The Wayland helper is a GNOME Shell extension; it applies to Linux only.' };
  if (!/gnome/i.test(input.desktop ?? '')) return { ok: false, reason: `This desktop is ${input.desktop || 'not GNOME'}. The helper is a GNOME Shell extension and does nothing elsewhere.` };
  const major = gnomeMajor(input.gnomeShellOutput ?? '');
  if (major === undefined) return { ok: false, reason: 'Could not read the GNOME Shell version (gnome-shell --version), so the helper was not installed.' };
  if (major >= HELPER_MAX_GNOME + 1) {
    return { ok: false, reason: `GNOME ${major} is newer than the helper supports. Cua turned it off from GNOME ${HELPER_MAX_GNOME + 1} because it crashed the Shell, and cua-driver 0.38 or newer lists native windows through the accessibility bus without it. Run \`clikcode computer driver update\` instead if windows are missing.` };
  }
  if (major < HELPER_MIN_GNOME) return { ok: false, reason: `GNOME ${major} is older than the helper supports (${HELPER_MIN_GNOME}-${HELPER_MAX_GNOME}).` };
  if (input.sessionType && input.sessionType !== 'wayland') return { ok: false, reason: `This is a ${input.sessionType} session; the helper is for Wayland.` };
  return { ok: true, major };
}

export const helperExplanation = 'The helper is a small GNOME Shell extension (winrects@cua) bundled with cua-driver. It lets cua-driver see where windows are on screen and draw its agent cursor. The installer copies it to ~/.local/share/gnome-shell/extensions and adds it to your enabled extensions with gsettings. GNOME loads extensions only at start-up, so you must log out and back in once afterwards.';
