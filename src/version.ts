/**
 * ClikCode's version, injected at build time.
 *
 * scripts/build.mjs passes esbuild
 * `define: { __CLIKCODE_VERSION__: JSON.stringify(pkg.version) }`, read from
 * package.json when it builds, so the published binary reports the version it
 * was packed as -- the one ClikDeploy stamps into package.json before
 * `npm publish` (whose prepack rebuilds). scripts/test-pack.mjs checks it. Outside that bundle (vitest, tsx, the legacy CLI's tsc build)
 * the identifier does not exist; `typeof` on an undeclared global is safe and
 * yields the fallback instead of a ReferenceError.
 */
declare const __CLIKCODE_VERSION__: string | undefined;
declare const __CLIKCODE_COMMIT__: string | undefined;

const CLIKCODE_VERSION_FALLBACK = '0.0.0-dev';

export const CLIKCODE_VERSION: string =
  typeof __CLIKCODE_VERSION__ === 'string' && __CLIKCODE_VERSION__
    ? __CLIKCODE_VERSION__
    : CLIKCODE_VERSION_FALLBACK;

/** `ClikCode/<version>` — for User-Agent / client-info fields sent by ClikCode. */
export const CLIKCODE_USER_AGENT = `ClikCode/${CLIKCODE_VERSION}`;

/** The git commit this build was made from (scripts/build.mjs), or undefined
 * outside a build made in a checkout. ClikCode Remote compares it with a
 * remote machine's to say whether that machine needs an update. */
export const CLIKCODE_COMMIT: string | undefined =
  typeof __CLIKCODE_COMMIT__ === 'string' && __CLIKCODE_COMMIT__ ? __CLIKCODE_COMMIT__ : undefined;
