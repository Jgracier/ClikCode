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
 * the bridge's `ready` carries this revision or later. A bridge older than
 * `oldestRevision` (absent: 1) is refused like an older protocol, with
 * "Update ClikCode": the editor keeps no screens for it.
 *   1  the chat, the pickers, `query slash-commands`
 *   2  `query` for providers, models, conversations, accounts, chat settings
 *      and the Gateway; `choose`; unknown queries answered with an error
 *   3  the bridge leaves for a newer installed build once quiet, saying so
 *      first (`host-retiring`, or `retiring` from a one-chat bridge): an
 *      event only, so an older editor just sees the bridge close
 *   4  `export-chat`, `import-chat` and `mark-moved`: a chat moved to
 *      another machine (session/move.ts)
 *   5  `chat-have`, and `export-chat` with `since`: a move sends only what
 *      the target lacks (a chat moving back to a machine that holds its old
 *      copy). Asked only of a target at 5; an older source ignores `since`
 *      and sends the whole chat, which any target reads
 *   6  `reclaim-moved`: a chat that moved on from this machine goes on here
 *      again, the client opening it reaching no machine it went to
 *   7  the `session-delta` feature (open's `features`): `session` events and
 *      relayed snapshots after the first whole one carry only the messages
 *      the editor lacks (`messagesFrom`, session-delta.ts). An older bridge
 *      ignores the feature and sends every event whole, which any editor reads
 *   8  `subagent`: read recorded child messages/tools and send supported steering
 *   9  Hosted AI: `query hosted` / `hosted-plan` and `choose hosted` (hosted-models/): models that run on
 *      this computer or on ClikDeploy, in one list
 *
 * ClikCode and the extension are published separately (the CLI first, in the
 * same ClikDeploy run), so a bump reaches npm before the extension that
 * expects it.
 */
export const IDE_PROTOCOL = {
  version: 1,
  revision: 9,
  oldestSupported: 1,
  oldestRevision: 2,
} as const;
