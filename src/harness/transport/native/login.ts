/** A vendor's own sign-in: a link shown on ClikCode's own screen where that
 * is all it is, otherwise the terminal handed to the vendor and watched. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { runLinkLogin, type LoginLink } from '../../../gateway/login/link.js';
import { runLoginSession } from '../../../gateway/login/session.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../../../gateway/login/url.js';
import { NativeHarnessSpec, resolveBinaryPath } from './binary.js';
import { run } from './command.js';
import { ensureNativeHarness } from './inspect.js';

/** Where a link sign-in's link and code are shown, and how it is cancelled.
 * The CLI's prompter, the VS Code panel, or (headless) plain stdout. */
export interface LinkSignInSurface {
  show(link: LoginLink): void;
  signal?: AbortSignal;
  /** The sign-in is over, however it ended. */
  done?(): void;
}

const linkSurfaces = new AsyncLocalStorage<LinkSignInSurface>();
let defaultLinkSurface: ((name: string) => LinkSignInSurface) | undefined;

/** Run `work` with its link sign-ins shown on `surface`. */
export function withLinkSignInSurface<T>(surface: LinkSignInSurface, work: () => Promise<T>): Promise<T> {
  return linkSurfaces.run(surface, work);
}

/** The surface for a process with one screen of its own (the IDE bridge). */
export function setLinkSignInSurface(factory: ((name: string) => LinkSignInSurface) | undefined): void {
  defaultLinkSurface = factory;
}

/** Headless (`clikcode accounts login`): the link printed, copied, and
 * opened where a browser is local. */
function stdoutLinkSurface(name: string): LinkSignInSurface {
  let opened = false;
  return {
    show: (link) => {
      const local = hasLocalDisplay();
      if (local && !opened) { opened = true; openLoginUrl(link.url); }
      process.stdout.write(`${local ? '' : loginUrlNotice(link.url).clipboard}Sign in to ${name}: ${link.url}\n${link.code ? `Code: ${link.code}\n` : ''}`);
    },
  };
}

/** A vendor sign-in that has to own a terminal, handed to whoever has one.
 * Set only by a process that has none of its own to give -- the IDE bridge,
 * whose stdio is a pipe to the editor, runs it in the editor's terminal. */
export interface VendorSignInRequest {
  command: string;
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
  name: string;
}

let vendorSignInRunner: ((request: VendorSignInRequest) => Promise<void>) | undefined;

export function setVendorSignInRunner(runner: ((request: VendorSignInRequest) => Promise<void>) | undefined): void {
  vendorSignInRunner = runner;
}

/** Login is always performed by the vendor CLI in the user's terminal. */
export async function loginNativeHarness(spec: NativeHarnessSpec, envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  // Before the install check: the terminal it runs in repeats this call, with
  // a screen for an installer or a sign-in to show progress on.
  // A link sign-in stays on ClikCode's own screen. A bridge with no screen
  // to install on still hands an uninstalled vendor to the editor's
  // terminal, where the installer has one.
  if (spec.loginLink && (!vendorSignInRunner || linkSurfaces.getStore() || await resolveBinaryPath(spec.binary))) {
    await ensureNativeHarness(spec);
    const shown = linkSurfaces.getStore() ?? defaultLinkSurface?.(spec.displayName) ?? stdoutLinkSurface(spec.displayName);
    const local = hasLocalDisplay();
    try {
      await runLinkLogin({
        binary: spec.binary, args: !local && spec.loginLink.remoteArgv ? spec.loginLink.remoteArgv : spec.loginArgv ?? [],
        env: envOverrides, displayName: spec.displayName, local, show: (link) => shown.show(link),
        ...(shown.signal ? { signal: shown.signal } : {}),
      });
    } finally { shown.done?.(); }
    return;
  }
  if (vendorSignInRunner) {
    await vendorSignInRunner({ command: spec.command, argv: spec.loginArgv ?? [], environment: envOverrides, name: spec.displayName });
    return;
  }
  await ensureNativeHarness(spec);
  // The vendor owns the terminal, exactly as it always has. ClikCode watches
  // the output through script(1) and, on the first sign-in URL, copies it to
  // the terminal's clipboard and opens a browser where one is any use -- the
  // half no vendor does for a user on a phone. Where there is no script(1)
  // (Windows) this falls back to plain inherited stdio.
  const teed = await runLoginSession({
    binary: spec.binary, args: spec.loginArgv ?? [], env: envOverrides, displayName: spec.displayName,
    io: { write: (chunk) => process.stdout.write(chunk) },
  });
  if (!teed.teed) { await run(spec.binary, spec.loginArgv ?? [], envOverrides); return; }
  if (teed.exitCode !== 0 && teed.exitCode !== null) {
    throw new Error(`${spec.displayName} sign-in exited with status ${teed.exitCode}`);
  }
}
