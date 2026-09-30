# Changelog

Releases are numbered MAJOR.MINOR.PATCH; the patch is assigned at publish time, so each
section covers a release line.

## 0.2

ClikCode in VS Code, rebuilt as a finished product: everything ClikCode is, in the panel.

- **On the right**, in the secondary side bar, like Claude Code and Codex (an activity bar view on
  VS Code older than 1.106). The ClikCode button at the top right of any editor opens it; *Open in
  New Tab* and *Open in New Window* open more chats, each with a conversation of its own.
- **A real composer**: `@` to mention files, `/` for every command with descriptions, attached
  selections and pasted images, send and stop in the box, steering while a turn runs.
- **Provider and Model** as two buttons in the composer footer. *Provider* lists all 25 harnesses,
  ClikDeploy Gateway and ClikCode Local, grouped by signed in / installed / available, with a
  search; a harness that is not installed installs when chosen, with progress shown. *Model* lists
  the models of the provider the chat is on, so it changes when the provider does.
- **Effort and permissions** (Ask / Auto / Bypass, plan mode, Gateway fast mode) in the footer.
- **Conversations**: search, resume, rename, fork, archive, delete, open in a new tab, or continue
  in the terminal (`clikcode sessions resume`) — the same list as the CLI, running ones first.
- **Accounts & usage**: every account per provider with 5-hour and weekly meters, sign in again,
  sign out, add accounts, switch the chat's account, automatic account switching on or off, and
  the ClikDeploy Gateway credit balance with *Buy credit*.
- **Settings, harness options, tools and MCP servers**: ClikCode's own Settings screen and its
  sub-screens now open inside the panel, with segmented controls for short choices.
- **Tool activity** as compact rows that link to the files they touch; a finished turn keeps its
  steps folded above the answer. Plans show as a checklist.
- **Approvals** inline above the composer (Allow / Always allow / Reject, keys 1-2-3); a proposed
  edit opens in a diff editor with *Accept* and *Reject* in the editor title bar.
- **Welcome screen** with the current provider and model, suggestions, recent conversations, and a
  sign-in card when the provider needs an account.
- Editor integration: *Add to ClikCode Chat* on the editor, editor tab and explorer context menus;
  `Alt+K` adds the selection; `Ctrl+Esc` (`Cmd+Esc`) moves focus between editor and chat;
  `Ctrl+N` (`Cmd+N`) starts a new chat in a focused chat; a *Get started* walkthrough.
- Notifications when a turn finishes or asks for approval while the chat is out of sight.
- Themed entirely from VS Code's colours (dark, light, high contrast), keyboard navigable with
  ARIA roles, and still with reduced motion.
- Needs ClikCode with IDE protocol revision 2 for the menus and screens above; with an older
  ClikCode the chat still works, with ClikCode's own pickers in the panel.

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
