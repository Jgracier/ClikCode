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
 * `revision` counts ADDITIVE requests within a version -- ones an older
 * bridge would not answer correctly, so the editor asks for them only when
 * the bridge's `ready` carries this revision or later. It never makes an
 * editor refuse a bridge: an older revision just gets the older screens.
 *   1  the chat, the pickers as quick picks, `query slash-commands`
 *   2  `query` for providers, models, conversations, accounts, chat settings
 *      and the Gateway; `choose`; unknown queries answered with an error
 *
 * ClikCode and the extension are published separately (the CLI first, in the
 * same ClikDeploy run), so a bump reaches npm before the extension that
 * expects it.
 */
export const IDE_PROTOCOL = {
  version: 1,
  revision: 2,
  oldestSupported: 1,
} as const;
