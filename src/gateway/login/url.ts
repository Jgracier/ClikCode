/**
 * Getting a vendor's sign-in URL onto the device the person is actually
 * holding.
 *
 * Every harness runs its own login, and the good ones do the same three
 * things: try to open a browser, print the URL when that fails, and accept a
 * pasted code back. Captured from Claude Code:
 *
 *   Opening browser to sign in…
 *   Browser didn't open? Use the url below to sign in (c to copy)
 *   https://claude.com/cai/oauth/authorize?…
 *   Paste code here if prompted >
 *
 * On a desktop the first step is enough. Over SSH from a phone it never
 * works -- the browser would open on the server -- so what matters is the
 * URL, and selecting a wrapped 300-character URL on a phone is miserable.
 * The one channel that does reach the phone is the clipboard: OSC 52 is
 * interpreted by the terminal emulator, not the host, which is why ClikCode's
 * own /copy already lands there rather than in the server's clipboard.
 *
 * The full URL is shown and linked locally. Sending it to a third-party
 * shortener would hand it a working sign-in link for the user's account.
 */
import { spawnPortable as spawn } from '../../harness/transport/spawn.js';
import { osc52Sequence } from '../../session/attachments.js';
import { loginPortForwardHint } from './link-info.js';
export { shortenLoginUrl } from './link-info.js';
import { HYPERLINK_CLOSE, hyperlinkOpen } from '../../tui/render/hyperlinks.js';

/** Show the exact authorization URL as both visible text and link target. */
export function loginLinkLine(url: string, hyperlinked = Boolean(process.stdout.isTTY)): string {
  return hyperlinked && /^https?:\/\//.test(url) && !/[\x00-\x1f\x7f]/.test(url)
    ? `${hyperlinkOpen(url)}${url}${HYPERLINK_CLOSE}`
    : url;
}

/** CSI/OSC sequences a vendor TUI colours its output with, which otherwise
 * land in the middle of a captured URL. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** A sign-in URL, or nothing. Deliberately narrow: only https, and only a
 * URL that looks like an authorisation endpoint, so an ordinary link printed
 * in a banner ("docs at https://…") is not mistaken for one. */
export function extractLoginUrl(text: string): string | undefined {
  // A link drawn inside a box (Cline's) ends at the border: box-drawing
  // and block characters are never part of a URL.
  const urls = stripAnsi(text).match(/https:\/\/[^\s"'<>)\]\u2500-\u259f]+/g) ?? [];
  const isAuth = (url: string): boolean =>
    /\b(?:oauth2?|auth|authorize|authorise|login|sign-?in|device|activate)\b|user_code=|_device\b/i.test(url);
  // The longest match wins among equals: an authorisation URL carries its
  // query string, and a truncated prefix of one is not a working link.
  return urls.filter(isAuth).sort((left, right) => right.length - left.length)[0];
}

/** Is a browser on THIS machine any use? Over SSH it is not: opening one on
 * the server helps nobody sitting at a phone. */
export function hasLocalDisplay(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return !environment.SSH_CONNECTION;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

/** Open the URL with the desktop's own handler. Never called without a local
 * display: on a headless box this would silently do nothing useful. */
export function openLoginUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] = platform === 'darwin'
    ? ['open', [url]] as const
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] as const
      : ['xdg-open', [url]] as const;
  const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
  child.on('error', () => { /* fail-open-ok: no handler installed is not a login failure */ });
  child.unref();
}

/** What to show once a sign-in URL has been seen, plus the escape sequence
 * that puts it on the clipboard of the terminal that is displaying this. */
export function loginUrlNotice(url: string, environment: NodeJS.ProcessEnv = process.env): {
  clipboard: string; lines: readonly string[];
} {
  const local = hasLocalDisplay(environment);
  return {
    clipboard: osc52Sequence(url, environment),
    lines: [
      `ClikCode · ${loginLinkLine(url)}`,
      ...(loginPortForwardHint(url) ? [loginPortForwardHint(url)!] : []),
      local
        ? 'A browser should have opened here; paste the link if it did not.'
        : 'Paste it into your phone\'s browser, then come back and paste any code below.',
    ],
  };
}

