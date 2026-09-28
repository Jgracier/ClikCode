# ClikCode for VS Code

A chat panel for [ClikCode](https://github.com/Jgracier/ClikCode), the harness that signs in all your
coding agents — Claude Code, Codex, Gemini CLI, GitHub Copilot, OpenCode, Cursor, Amp, Qwen and more —
and keeps one conversation you can move between them.

![The ClikCode chat beside the editor, answering a question about a selection](https://raw.githubusercontent.com/Jgracier/ClikCode/main/packages/vscode/media/screenshots/chat.png)

## Features

- **Where you expect it.** The ClikCode button in the editor title bar (top right) opens the chat as a
  tab beside your code, as Claude Code and Codex do; it also lives in the activity bar, and can be
  dragged to the secondary side bar. Every place shows the same chat.
- **One chat, every agent.** Pick the harness, model, account, reasoning effort and permission mode
  from quick picks (or the chips at the top of the chat). The lists are ClikCode's own pickers, so
  they match the terminal exactly.
- **Streaming answers** rendered as Markdown, with the agent's tool activity, plan and token usage
  as it works.
- **Steer or stop a running turn.** Type while the agent works to steer it (or queue the message
  when the harness cannot take it mid-turn); press **Esc** or **Stop** to cancel.
- **Approvals with a real diff.** When an agent asks to change a file, the proposed change opens in
  VS Code's diff editor; approve once, always, or deny from the chat.
- **Sign in where you are.** When a vendor needs you to sign in, its own login runs in a VS Code
  terminal and the turn carries on when it finishes.
- **Editor context.** *ClikCode: Ask About Selection* sends the selection with its file and line
  numbers; *Attach File to Next Message* attaches a file; chats open in your workspace folder.
- **The same conversations as the terminal.** Chats started in `clikcode` show up here and the other
  way round (*ClikCode: Resume Chat…*), including a turn still running in another window.
- **Automatic account switching** when an account hits its usage limit, as in the CLI.
- **Every slash command**: *ClikCode: Run Slash Command…*, or type `/` in the chat. `!command` runs a
  shell command and hands its output to the next request.

## Requirements

- **ClikCode** installed and on your `PATH`:

  ```sh
  npm install -g clikcode
  ```

  The extension runs *your* installed ClikCode rather than a copy of its own, so the editor and the
  terminal always share one version, one set of accounts and one history. If ClikCode is missing,
  the chat offers to install it; if it is too old for this extension, the chat says so and offers
  *Update ClikCode* (`npm install -g clikcode@latest`). Without access to the npm registry, install
  the same release from GitHub:
  `npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz`.
- **Node.js 22.12 or newer** for ClikCode. The extension uses `node` from your `PATH`, or VS Code's
  built-in Node.js when that is new enough, or the `clikcode.nodePath` setting.
- At least one coding agent account. The first message offers to sign in to one.

## Commands

| Command | Default key |
| --- | --- |
| ClikCode: Open Chat | `Ctrl+Alt+C` (`Ctrl+Cmd+C` on macOS) |
| ClikCode: Open Chat in Editor | the ClikCode button in the editor title bar |
| ClikCode: Ask About Selection | `Ctrl+Alt+Q` (`Ctrl+Cmd+Q`) with a selection |
| ClikCode: Stop the Running Turn | `Esc` in the chat |
| ClikCode: New Chat / Resume Chat… | |
| ClikCode: Choose Provider… / Model… / Account… / Reasoning Effort… / Permissions… | |
| ClikCode: Chat Settings… / Run Slash Command… | |
| ClikCode: Attach File to Next Message | editor and explorer context menus |
| ClikCode: Restart Connection / Show Log | |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `clikcode.path` | *(PATH)* | The `clikcode` executable or its `dist/index.js`. |
| `clikcode.nodePath` | *(PATH, then VS Code's)* | Node.js 22.12+ to run ClikCode with. |
| `clikcode.openDiffOnApproval` | `true` | Open proposed changes in a diff editor. |
| `clikcode.startWith` | `continue` | Continue the workspace's latest chat, or start a new one. |

## Privacy

The extension talks only to the ClikCode process it starts on your machine. Your prompts go to the
agent you choose, exactly as when you use it in a terminal; credentials stay with each vendor's own
CLI. Model output is rendered without running any of it: raw HTML is shown as text, images are not
loaded, and links open in your browser only when you click them.

## How it works

The chat starts `clikcode ide-bridge` and talks to it over a private IPC channel. The bridge is the
same client the terminal uses: it attaches to the conversation's session worker (one background
process per conversation, shared with any terminal that has it open), loads what a turn needs,
sends queued messages when a turn ends, and asks the editor whenever the terminal would ask you.

## Feedback

Issues and ideas: <https://github.com/Jgracier/ClikCode/issues>.
