/**
 * ClikCode's version, injected at build time.
 *
 * apps/clikcode/scripts/build.mjs passes esbuild
 * `define: { __CLIKCODE_VERSION__: JSON.stringify(pkg.version) }`, read from
 * apps/clikcode/package.json, so the published binary reports the version it
 * was packed as. Outside that bundle (vitest, tsx, the legacy CLI's tsc build)
 * the identifier does not exist; `typeof` on an undeclared global is safe and
 * yields the fallback instead of a ReferenceError.
 */
declare const __CLIKCODE_VERSION__: string | undefined;

export const CLIKCODE_VERSION_FALLBACK = '0.0.0-dev';

export const CLIKCODE_VERSION: string =
  typeof __CLIKCODE_VERSION__ === 'string' && __CLIKCODE_VERSION__
    ? __CLIKCODE_VERSION__
    : CLIKCODE_VERSION_FALLBACK;

/** `ClikCode/<version>` — for User-Agent / client-info fields sent by ClikCode. */
export const CLIKCODE_USER_AGENT = `ClikCode/${CLIKCODE_VERSION}`;
