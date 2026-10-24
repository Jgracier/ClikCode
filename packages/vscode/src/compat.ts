/** Whether the installed ClikCode can drive this extension, and how the user
 * gets one that can. The protocol numbers live in ClikCode's own source
 * (src/ide/protocol-version.ts), bundled here as the one copy of them. */
import { IDE_PROTOCOL } from '../../../src/ide/protocol-version.js';
import { failureText } from '../../../src/harness/protocol/stderr-line';

export { IDE_PROTOCOL };

/** Installs or updates ClikCode. The terminal runs this one. */
export const INSTALL_COMMAND = 'npm install -g clikcode@latest';
/** The same release, straight from GitHub, for when the npm registry is not reachable. */
export const INSTALL_FALLBACK_COMMAND = 'npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz';
export const INSTALL_HELP = `${INSTALL_COMMAND} (or, without the npm registry: ${INSTALL_FALLBACK_COMMAND})`;

/** What the connection banner offers when ClikCode cannot be used. */
export type Remedy = 'install' | 'update-clikcode' | 'update-extension';

export type Compatibility = { ok: true } | { ok: false; remedy: Exclude<Remedy, 'install'>; message: string };

/** Judges the bridge by its `ready` event. */
export function bridgeCompatibility(
  ready: { version: string; protocol?: unknown; revision?: unknown },
  supported: { version: number; oldestSupported: number; oldestRevision?: number } = IDE_PROTOCOL,
): Compatibility {
  const protocol = typeof ready.protocol === 'number' && Number.isInteger(ready.protocol) ? ready.protocol : 0;
  const revision = typeof ready.revision === 'number' && Number.isInteger(ready.revision) ? ready.revision : 1;
  // Newer than this extension knows first: a future bridge may not say its
  // revision the way this one reads it.
  if (protocol > supported.version) {
    return {
      ok: false, remedy: 'update-extension',
      message: `ClikCode ${ready.version} speaks bridge protocol ${protocol}, newer than this extension knows (${supported.version}). Update the ClikCode extension.`,
    };
  }
  if (protocol < supported.oldestSupported || revision < (supported.oldestRevision ?? 1)) {
    const has = protocol < supported.oldestSupported ? `bridge protocol ${protocol || 'none'}; it needs ${supported.oldestSupported} or newer` : `bridge revision ${revision}; it needs ${supported.oldestRevision} or newer`;
    return {
      ok: false, remedy: 'update-clikcode',
      message: `ClikCode ${ready.version} is too old for this extension (${has}). Update ClikCode: ${INSTALL_HELP}`,
    };
  }
  return { ok: true };
}

/** What the extension build recorded about the ClikCode it was made against
 * (scripts/build.mjs); absent when run from source, as in the tests. */
declare const __CLIKCODE_BUILT_AGAINST__: { protocol: number; revision: number; commit: string } | undefined;
export const BUILT_AGAINST = typeof __CLIKCODE_BUILT_AGAINST__ === 'undefined' ? undefined : __CLIKCODE_BUILT_AGAINST__;

/** One line for a bridge that works but is not the revision this bundle was
 * built against (a newer ClikCode with additive changes the bundle does not
 * know, or an older one): version skew made visible rather than silent. */
export function versionSkew(
  ready: { version: string; revision?: unknown },
  expected: { revision: number } = IDE_PROTOCOL,
  built: { commit: string } | undefined = BUILT_AGAINST,
): string | undefined {
  const revision = typeof ready.revision === 'number' && Number.isInteger(ready.revision) ? ready.revision : 1;
  if (revision === expected.revision) return undefined;
  return `ClikCode ${ready.version} speaks bridge revision ${revision}; this extension was built for revision ${expected.revision}${built ? ` (ClikCode ${built.commit})` : ''}. Some features may be missing until both are updated.`;
}

/** A ClikCode from before `ide-bridge` existed rejects the command outright
 * (commander's "unknown command" on stderr) and exits before `ready`. */
export function bridgeCommandMissing(log: readonly string[]): boolean {
  return log.some((line) => /unknown command ['"]?ide-bridge/i.test(line));
}

/** What the bridge said as it went, to follow a banner's words: `: <its last output>`, or
 * `none` when it wrote nothing. The whole region, not a line: the cause may not be the last one. */
export function startLogCause(log: readonly string[], none = ''): string {
  const said = failureText(log.slice(-40).join('\n'));
  return said ? `:\n${said}` : none;
}

export function tooOldToStartMessage(): string {
  return `The installed ClikCode has no editor bridge (\`clikcode ide-bridge\`): it is older than this extension. Update ClikCode: ${INSTALL_HELP}`;
}

/** The first VS Code that takes a `secondarySidebar` view container. */
const SECONDARY_SIDEBAR_SINCE = [1, 106] as const;

export function supportsSecondarySidebar(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > SECONDARY_SIDEBAR_SINCE[0] || (major === SECONDARY_SIDEBAR_SINCE[0] && minor >= SECONDARY_SIDEBAR_SINCE[1]);
}
