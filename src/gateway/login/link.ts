/**
 * A vendor sign-in that is only a link (and often a code) approved in a
 * browser, run without handing anyone a terminal.
 *
 * Grok, Amp, Kimi, MiniMax, OpenHands and Cursor print a link and wait; so do
 * Codex and Copilot in their device-code modes. Nothing is ever typed into
 * them, so the terminal they used to be handed only ever showed a link. Here
 * the vendor runs down a pty in the background (script(1): several check for
 * a TTY before they print anything) and ClikCode shows the link and code on
 * its own screen -- the CLI's, or the VS Code panel's.
 *
 * Exactly one browser tab: every way a vendor opens one (xdg-open, open, gio,
 * $BROWSER) is a stand-in that records the URL instead, and the screen opens
 * it. Where a browser is local, the URL the vendor tried to open is the one
 * it prefers (its localhost callback finishes without a pasted code); where
 * none is (SSH from a phone), the printed one is.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnPortable as spawn, terminatePortable } from '../../harness/transport/spawn.js';
import { runTeedLogin } from './tee.js';
import { extractLoginUrl, stripAnsi } from './url.js';

export interface LoginLink { url: string; code?: string }

/** A device code: from the link's own `user_code`, else the first
 * `XXXX-XXXX`-shaped token printed (Grok, Amp, Kimi, Codex, Copilot all
 * print one). */
export function extractLoginCode(text: string, url?: string): string | undefined {
  if (url) {
    try {
      const fromUrl = new URL(url).searchParams.get('user_code');
      if (fromUrl) return fromUrl;
    } catch { /* fail-open-ok: not a parseable URL, read the text instead */ }
  }
  // Never from inside a link (Cursor's carries a UUID whose middle looks
  // like one), and never a piece of a longer dashed token.
  const prose = stripAnsi(text).replace(/https?:\/\/\S+/g, ' ');
  return prose.match(/(?<![\w-])[A-Z0-9]{4,5}-[A-Z0-9]{4,5}(?![\w-])/)?.[0];
}

/** Which link to show: the one the vendor tried to open where a browser is
 * local, the printed one where it is not. */
export function chooseLoginLink(input: { printed?: string; opened?: string; local: boolean }): string | undefined {
  return input.local ? input.opened ?? input.printed : input.printed ?? input.opened;
}

const OPENERS = ['xdg-open', 'open', 'gio', 'sensible-browser', 'x-www-browser', 'www-browser'];

/** Executables that record the URL they were asked to open, one per line. */
async function openerStandIns(): Promise<{ dir: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-open-'));
  const log = join(dir, 'opened');
  const script = '#!/bin/sh\nfor a; do case "$a" in http://*|https://*) printf \'%s\\n\' "$a" >> "$CLIKCODE_OPENED";; esac; done\n';
  await Promise.all(OPENERS.map(async (name) => {
    await writeFile(join(dir, name), script);
    await chmod(join(dir, name), 0o755);
  }));
  return { dir, log };
}

/** Run a link sign-in to the end. `show` is called once the link is known
 * (with its code, if one comes within a moment) and again if the code turns
 * up later. Resolves when the vendor exits 0; rejects when it fails or
 * `signal` cancels it. */
export async function runLinkLogin(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  displayName: string;
  local: boolean;
  show: (link: LoginLink) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error(`sign-in to ${input.displayName} was cancelled`);
  const standIns = process.platform === 'win32' ? undefined : await openerStandIns();
  const env: Record<string, string> = {
    ...input.env,
    ...(standIns ? {
      PATH: `${standIns.dir}${delimiter}${input.env.PATH ?? process.env.PATH ?? ''}`,
      BROWSER: join(standIns.dir, 'xdg-open'),
      CLIKCODE_OPENED: standIns.log,
    } : {}),
  };
  let raw = '';
  let opened: string | undefined;
  let shown: LoginLink | undefined;
  let pending: NodeJS.Timeout | undefined;
  const publish = (final = false): void => {
    const url = chooseLoginLink({ printed: extractLoginUrl(raw), opened, local: input.local });
    if (!url) return;
    const code = extractLoginCode(raw, url);
    if (shown && shown.url === url && shown.code === code) return;
    // A code usually follows its link by a line or two: wait a moment for it
    // rather than show the link twice.
    if (!code && !shown && !final) {
      pending ??= setTimeout(() => { pending = undefined; publish(true); }, 400);
      return;
    }
    if (pending) { clearTimeout(pending); pending = undefined; }
    shown = { url, ...(code ? { code } : {}) };
    try { input.show(shown); } catch { /* fail-open-ok: showing must never break the login */ }
  };
  const poll = standIns ? setInterval(() => {
    void readFile(standIns.log, 'utf8').then((text) => {
      const last = text.trim().split('\n').pop();
      if (last && last !== opened) { opened = last; publish(); }
    }, () => undefined);
  }, 200) : undefined;

  let exitCode: number | null;
  try {
    const teed = await runTeedLogin({
      binary: input.binary, args: input.args, env,
      write: () => { /* the screen shows the link, not the vendor's text */ },
      onOutput: (chunk) => { raw += chunk; publish(); },
      // Never the terminal: ClikCode's own screen keeps it.
      onStdin: () => undefined,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    exitCode = teed.teed ? teed.exitCode : await runPiped(input.binary, input.args, env, (chunk) => { raw += chunk; publish(); }, input.signal);
  } finally {
    if (poll) clearInterval(poll);
    if (pending) clearTimeout(pending);
    if (standIns) await rm(standIns.dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (input.signal?.aborted) throw new Error(`sign-in to ${input.displayName} was cancelled`);
  if (exitCode !== 0) {
    const said = stripAnsi(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    throw new Error(`${input.displayName} sign-in exited with status ${exitCode}${said ? `: ${said}` : ''}`);
  }
}

/** Where there is no script(1) (Windows): plain pipes. A vendor that
 * insists on a TTY fails here, and says so. */
function runPiped(binary: string, args: readonly string[], env: Record<string, string>, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const abort = (): void => { terminatePortable(child, 'SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code) => { signal?.removeEventListener('abort', abort); resolve(code); });
  });
}
