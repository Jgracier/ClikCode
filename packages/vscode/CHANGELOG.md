# Changelog

Releases are numbered MAJOR.MINOR.PATCH; the patch is assigned at publish time, so each
section covers a release line.

## 0.1

First release.

- Chat panel in the activity bar (movable to the secondary side bar) on the installed ClikCode.
- A ClikCode button in the editor title bar opens the same chat as an editor tab beside your code; the tab reopens with VS Code.
- Streaming Markdown answers with tool activity, plan and token usage.
- Steer, queue and stop turns; queued messages are sent in order when a turn ends.
- Approvals with a diff editor preview: approve once, always, or deny.
- Vendor sign-ins in a VS Code terminal.
- Quick picks for provider, model, account, effort, permissions, chat settings and chats.
- Every ClikCode slash command, from the chat or the command palette.
- Ask About Selection and Attach File, with the workspace folder as the chat's directory.
- Status bar item showing the chat's harness and model.
- Detects a ClikCode too old for the extension (or newer than it knows) and offers *Update ClikCode*
  (`npm install -g clikcode@latest`) or an extension update.
