/** The version of the protocol `clikcode ide-bridge` speaks, and the oldest
 * one an editor extension built from this source still accepts -- the one
 * place either is written. The bridge sends `IDE_PROTOCOL.version` in its
 * `ready` event; the VS Code extension bundles this file (it imports nothing)
 * and compares (packages/vscode/src/compat.ts):
 *
 *   bridge older than `oldestSupported` (or no `protocol` at all, i.e. a
 *     ClikCode from before this field)  -> "Update ClikCode"
 *   bridge newer than `version`           -> "Update the ClikCode extension"
 *
 * Bump `version` ONLY for a change an editor built against the previous one
 * cannot handle: a request or event removed, renamed or reshaped. A new
 * optional field or a new event type needs no bump -- both sides ignore what
 * they do not know (see bridge-client.ts isIdeEvent). Raise `oldestSupported`
 * when this source stops handling an older bridge's messages.
 *
 * ClikCode and the extension are published separately (the CLI first, in the
 * same ClikDeploy run), so a bump reaches npm before the extension that
 * expects it.
 */
export const IDE_PROTOCOL = {
  version: 1,
  oldestSupported: 1,
} as const;
