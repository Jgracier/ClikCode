# ClikCode

**The harness that logs in all your favorite AI coding providers — in the terminal and in VS Code.** Chats you can resume in any of them, and automatic account switching when you hit a usage limit.

Claude Code for one thing, Codex for another, Copilot because it came with the
editor, something you tried once and kept. Each has its own commands, its own
sign-in, its own idea of where your conversations live. None of them know the
others exist, so picking one up means learning it again and leaving your work
behind in the last one.

ClikCode sits in front of 29 of them, including four newer ACP agents under
experimental support. One sign-in, one list of conversations, one
set of controls, the same keystrokes whichever tool answers. It replaces
nothing — your tools stay yours, the logins you already had keep working — and
what it adds is this:

For the 21 harnesses with an ACP entry point or adapter, ClikCode uses ACP for
ordinary turns. When an agent cannot carry a particular image, model, or
reasoning choice over ACP, ClikCode uses that harness's CLI path where safe.
Any other ACP agent can be added with `clikcode acp add`, and it then appears
in the same provider list.

For example, `clikcode acp add my-agent /path/to/agent -- --stdio` registers
an installed ACP executable without changing ClikCode. In VS Code, use
**Add ACP Harness…** and enter launch arguments as a JSON array, such as
`["--stdio", "--config", "two words"]`. The agent still needs its own usable
credentials; a completed turn and resume should be checked before relying on
it for work.


**Every tool, one way of working.** Stop memorizing flags. ClikCode asks each
tool what it supports and offers you that — models, reasoning level, approval
behavior — in the same place every time.

**All your accounts, at once.** Work and personal, two subscriptions, an API
key kept for spillover. Keep them side by side and move between them in a
keystroke. Signing in still happens inside the tool itself; ClikCode never
sees your password or your key, only which account is which.

**One list of conversations.** Not one list per tool. Whichever one you were
using when you started a chat, it is in the same list, and you can carry it on
somewhere else. Chats you began in Claude Code or Codex directly, long before
ClikCode was involved, are in that list too.

**Run out, and keep going.** When an account hits its limit, ClikCode moves to
the next one and the answer keeps arriving. It takes the conversation with it,
so the model continues from what was actually said rather than a summary of
it. Nothing to click. You find out afterwards.

## Install

```sh
npm install -g clikcode
```

Update the same way: `npm install -g clikcode@latest`. Without access to the npm
registry, install the same release from GitHub:
`npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz`.

For VS Code (and VSCodium, Cursor, Windsurf), the **ClikCode** extension
(`clikcode.clikcode`, on the Visual Studio Marketplace and Open VSX) puts the
same chats in a panel beside your code; it runs the ClikCode you installed.
The same slash commands work there. Its chat bar shows the account's usage and,
where turns report a price, what the chat has cost so far ("$1.23 this chat").
Right-click a file, in the editor or the explorer, for **Open the Conversation
That Edited This File**.

Requires **Node.js 22.12 or newer**. Nothing to configure. You do not need any
of the coding tools installed first: choose one — to sign in, or as the tool for
a conversation — and ClikCode installs it for you, with the vendor's own npm
package or installer.

Deep Agents Code, Devin CLI, Junie CLI and MiniMax Code are experimental ACP
integrations. Their official install and launch commands are wired. Devin,
Junie and MiniMax Code installed and answered ACP initialization on Linux;
authenticated turns remain unverified without usable vendor accounts. When an
agent offers one browser sign-in method over ACP, an interactive ClikCode turn
uses it; terminal sign-in methods still run through the vendor's CLI. See the
[per-harness verification record](https://github.com/Jgracier/ClikCode/blob/main/docs/ACP_OAUTH_VERIFICATION.md).

Google [ended Gemini CLI access for individual accounts](https://github.com/google-gemini/gemini-cli/discussions/28017).
Gemini Code Assist enterprise licenses and API key access remain supported by
the vendor; ClikCode cannot restore individual-account access.

## Your first five minutes

Start by seeing what you can sign in to, then sign in to something:

```sh
clikcode accounts providers          # every supported tool, and how each signs in
clikcode accounts login claude       # installs the CLI first if you need it
clikcode                             # start talking
```

That second command runs the vendor's own sign-in — the same browser window
you would have seen running `claude` yourself. ClikCode watches it happen and
notes that the account exists. It does not read what came back.

Add more whenever you like, and name them so you can tell them apart:

```sh
clikcode accounts login claude --label work
clikcode accounts login codex --label personal
clikcode accounts list               # what you have, and what is left on each
```

Now type `clikcode` and you are in a session. Press `/` for a searchable list
of everything you can do from here. That is the whole setup.

## Three things to know

Everything in ClikCode is one of three nouns, and they stack in this order.

**A tool** is Claude Code, Codex, Gemini, Copilot — the thing that actually
does the work. `clikcode doctor` tells you which ones are on this machine, what
version, and what each can do.

**An account** is one sign-in to one tool. Most people end up with several.
Accounts are kept apart from one another, and apart from the login you already
had before ClikCode existed — that one keeps working exactly as it did.

**A conversation** belongs to you, not to a tool. It has a name, a history and
a working directory, and it survives changing your mind about which tool or
which account should answer it. Running `clikcode` with no arguments picks up
the last one you were in.

## Driving it

Two keys do almost everything.

**Right Arrow opens, and Right Arrow selects.** On an empty line it opens the
command list. On a highlighted row it opens that row — a tool, an account, a
conversation. You can go a long way without typing anything.

**Left Arrow goes back** out of any menu or picker, and never confirms. That
one rule is why you can explore a menu without worrying about setting something
by accident. (In the composer it moves the cursor, as you would expect.)

| Key | What it does |
| --- | --- |
| **→** | Open the command list, or select what is highlighted |
| **←** | Back, one level. On an empty message line, the conversation board: what is running, and what you can resume |
| **↑ ↓** | Move through a list; in an empty composer, your previous messages |
| **Enter** | Send, or confirm the highlighted row. While an answer runs, what you type is steered into it at its next pause or waits for it to end (`/send steer\|queue`); Enter again with nothing typed puts the waiting message into the answer now, which keeps running |
| **Tab** | Complete the highlighted command |
| **Delete** | In a picker, the destructive action on a row — remove an account, delete a conversation |
| **Esc** | While an answer runs: back to the live end if you have scrolled up; otherwise your newest waiting message comes back to edit; with none waiting, a prompt not answered yet comes back to edit, and an answer already under way stops. Otherwise closes the command list and clears its filter |
| **Ctrl+C** | Stop the answer (one with nothing in it yet gives your prompt back, unless you have typed something). On a draft, clears it; twice within two seconds exits |
| **Ctrl+D** | Exit, on an empty line |
| **Ctrl+Z** | Drop to a shell; `fg` brings you back |
| **Ctrl+L** | Redraw the fullscreen view if a terminal loses or garbles cells; keeps the chat and draft |
| **PgUp / PgDn** | Scroll back through the conversation |

Enter sends. For a newline that works in every terminal and over every SSH
client, end the line with a backslash and press Enter; Shift+Enter also works
where the terminal supports it.

Scrolling with a mouse or a trackpad works. When you want your terminal's own
selection instead — to copy something out — `/select` releases the mouse, and
`/select` again takes it back.

## Signing in, and adding more

`clikcode accounts login <tool>` runs that tool's own sign-in and gives the
result a name. Run it again with a different `--label` and you have a second
account. Nothing stops you at two.

That is what makes the rest possible — running out only survives if there is
somewhere else to go.

Each account gets its own directory under `~/.clikcode/profiles/`, and
ClikCode points the tool at it for one child process at a time. Nine tools
have a supported setting for that — `CLAUDE_CONFIG_DIR` (Claude Code),
`CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`,
`PI_CODING_AGENT_DIR`, `HERMES_HOME`, `OPENCLAW_STATE_DIR` and `VIBE_HOME`
(Mistral Vibe). Nothing global changes, and the `~/.claude`, `~/.codex` logins
you already had are untouched.

The other twenty have no such setting, so ClikCode points `HOME` elsewhere for
that one process instead. On its own that would also hide your git, npm, GitHub
CLI, Docker, GnuPG, Cargo, rustup and ssh-agent configuration from the agent,
so ClikCode points those back at your real home. Turns still commit, push and
install as you.

Switch by hand with `/account` in a session, or
`clikcode sessions set <id> --account <label>`.

## When an account runs out

ClikCode watches how much each account has left — `/usage` shows it, and it
sits in the corner of the screen while you work. When the one you are on is
spent, the turn moves to another account of the same tool and the answer keeps
arriving. You are told after the fact, not asked first.

What travels is the point. ClikCode copies the tool's own conversation file
into the next account and resumes it there, so the model continues the real
thread instead of a summary of it. It does not re-read your project, and it
does not forget what it just said.

This happens automatically whenever another usable account for the same
provider and transport is available.

## Resume anything, from anywhere

`/resume` shows two things: your ClikCode conversations, and chats the tools
started on their own — ones you ran in Claude Code or Codex directly, before
ClikCode was involved.

Pick one of the second kind and it becomes one of the first. It gets a row in
your list, and you can carry it on, fork it, rename it or hand it to another
tool.

Claude Code, Codex and OpenCode hand over their full history when adopted, so
you can scroll back through it. For the others the thread is real and the tool
remembers all of it, but ClikCode's own view starts at your next message.

## Moving a conversation to another tool

Changing accounts keeps you on the same tool. Changing the tool is one
command: `/provider` to pick from a list, or its name directly — `/claude`,
`/codex`, `/gemini` — with your next message on the same line.

```
/codex have another look at the migration
```

The conversation keeps its name, its history and its place in your list. No
vendor can read another vendor's memory, so ClikCode writes the conversation
into the new tool's own thread where it knows that tool's format, and sends it
as context where it does not. When a tool has already summarized the opening
turns (a compaction), the summary goes in their place; `/history` and
`/export` show it, and the conversation's row says "first N turns summarized".
On a long thread that costs tokens and a few seconds. Nothing else changes.

## One MCP server, whichever tool you choose

Tools that support MCP each want it configured their own way. Add a server
once. ClikCode's own agent uses it immediately. Another harness gets it the
first time you choose that provider, and only if that name is not already
there:

```sh
clikcode mcp targets                        # how each harness would receive it
clikcode mcp add postgres -- npx -y pg-mcp  # record it; install on choose
clikcode mcp list                           # what is recorded, and which harnesses have it
clikcode mcp remove postgres                # forget it, and take ClikCode's copies back out
clikcode mcp login <name>                   # OAuth sign-in to a remote server, for ClikCode's own agent
clikcode mcp logout <name>                  # forget that sign-in
```

`mcp remove` takes out only the copies ClikCode itself wrote. A server you
added to a tool by hand stays where you put it.

ClikCode does not host or proxy these servers. Each tool talks to them
directly, exactly as it would if you had configured it by hand. Skills follow
the same rule. Hooks are never copied: Claude Code and Grok already run
Claude's hook files themselves, and every other harness uses its own hook
format, so ClikCode leaves those alone.

Claude Code's plugins (skills, commands, agents, hooks, MCP servers) can be
used by ClikCode's own agent too. `clikcode plugin list` shows the plugins
installed for Claude Code and whether ClikCode uses each;
`clikcode plugin enable <plugin>` and `disable <plugin>` choose. Installing a
plugin stays Claude Code's job.

## Everyday commands

Everything above is reachable from the command line too, for scripting or for
when you would rather type than pick.

| Command | What it does |
| --- | --- |
| `clikcode` | Open (or resume) the default interactive session |
| `clikcode doctor` | Which tools are installed, their versions and what each can do |
| `clikcode accounts providers` | Every supported tool and how it signs in |
| `clikcode accounts login <tool> [--label <label>]` | Run that tool's own login, kept separate from your others |
| `clikcode accounts list` / `status` / `logout` / `remove` | Your accounts: what they are called, and what is left on each |
| `clikcode models` | The models your local accounts offer |
| `clikcode usage` | The calls and tokens ClikCode recorded, every one (what is left on each account is `accounts list`) |
| `clikcode sessions list` / `show` / `create` / `resume` (also `open`) / `send` / `command` / `set` / `close` | Your conversations, including ones a tool started on its own; `command <id> <slash…>` runs a slash command on one |
| `clikcode send <prompt> [--chat <id\|name\|last>] [--harness <tool>] [--model <model>] [--permissions <mode>]` | Send one message without opening a session: a new chat, or continue one |
| `clikcode search <words>` | Find the conversations that mention something, any provider, most mentions first; `--json` gives each hit and its first mention |
| `clikcode logs [--session <id>] [--role <role>] [--since 10m] [-f]` | What every ClikCode window, worker and editor bridge did, in order; the first place to look when something went wrong |
| `clikcode permissions [ask\|bypass\|auto]` | Approval behavior for the active chat |
| `clikcode mcp add` / `list` / `remove` / `login` / `logout` / `targets` | One MCP server for every tool (below) |
| `clikcode plugin list` / `enable <plugin>` / `disable <plugin>` | Which of Claude Code's plugins ClikCode's own agent uses |
| `clikcode acp add <command> <binary> [-- <flags>]` / `acp list` / `acp remove` | An ACP agent the catalog does not ship |
| `clikcode start` / `status` / `stop` | The optional local control API (below) |
| `clikcode gateway login [--github]` / `gateway status` / `gateway models` | ClikDeploy Gateway sign-in (Google by default), and the models it offers |
| `clikcode gateway usage [--days N]` | Your AI use and credit as ClikDeploy Gateway records it: every call, by surface and model |
| `clikcode gateway credit [--amount USD]` | Add AI credit: opens a Stripe checkout ($5–$500). Paying it also saves your card for automatic top-ups when credit runs low |
| `clikcode gateway credit --auto-topup on\|off` | Turn those automatic top-ups on or off |

Output is JSON when it is not going to a terminal, so ClikCode scripts
cleanly -- one record per line, so a command that reports twice is still
parseable -- and readable text when it is. `--json` or `--human` forces one,
and `--debug` adds the stack and HTTP detail when something fails.

## Inside a session

Most of the time you will not type any of those. You will be in a session,
where everything is a slash away.

Pressing `/` opens a searchable list of ClikCode's 46 commands. Ten are pinned
at the top, in the order people reach for them: resume a conversation, pick a
tool, an account on it, then its model, start over, change what needs your
approval, then settings, sessions, status and help. (The terminal leaves
`/resume` out of the list — ← on an empty line is the conversation board — so
it pins nine; typed, `/resume` still works.)

| Command | What it does |
| --- | --- |
| `/resume` | resume another conversation |
| `/provider` | choose a provider |
| `/account [label]` | switch accounts |
| `/model [name]` | choose or set a model |
| `/new [first message]` | start a fresh conversation (the current one stays resumable) |
| `/permissions [ask\|bypass\|auto]` | approval behavior |
| `/settings` | configure this workspace (below) |
| `/sessions` | manage conversations |
| `/status` | current configuration |
| `/help` (also `/?`) | all commands |

`/help` lists every command grouped by topic instead of by frequency, since a
reference reads better that way. All of them, grouped as `/help` groups them:

**Conversation**

| Command | What it does |
| --- | --- |
| `/new [first message]` (also `/clear`, `/reset`) | start a fresh conversation (the current one stays resumable) |
| `/compact [focus]` | summarize the conversation and continue in a fresh native session (a vendor tool; ClikCode's own agent compacts by itself) |
| `/history` | show this conversation; a summary carried for its opening turns comes first |
| `/hindsight` | this conversation cut into topics, newest first, with the files each one changed, numbered by your prompts — the numbers `/fork @N` and `/redo @N` take |
| `/copy` | copy the last answer |
| `/export [path]` | write the transcript as markdown |
| `/changes [N\|path]` | each turn's file edits, newest first; `N` shows that turn's diff. With a path, every turn in any conversation that edited that file, newest first: pick one and its conversation opens at that turn (↑↓ to the others) |
| `/redo [@N] [keep]` | go back to before one of your prompts and send it again, edited or not; that turn's file edits and every later one's are put back (unless `keep`), and a file changed since is left alone and named. The conversation as it was is archived beside it. ClikCode's agent restores its own snapshots; a vendor harness's edits are reversed from the diffs it reported (not on the plain-text CLIs, Aider and Continue). What a shell command changed is put back only for ClikCode's agent, and only files tracked in the git repository. To undo a turn, `/redo` to before it and leave the prompt unsent; there is no separate undo command |
| `/native <text>` (also `//text`) | send text straight to the tool, unchanged |
| `/select` | release the mouse so you can select and copy text |
| `/redraw` | repaint the screen |
| `/exit` (also `/quit`) | save and leave |

Every turn's file changes are recorded for the whole conversation, so
`/changes`, `/hindsight` and `/redo` reach back to its first turn. The record
of an old turn keeps its files and line counts, but once a conversation's log
passes 2 MiB the oldest turns' diff text is dropped; such a turn is listed,
not reversed.

**Workspace**

| Command | What it does |
| --- | --- |
| `/review [focus]` | ask the provider to review uncommitted changes |
| `/init` | create or improve the tool's own instructions file for this project |
| `/memory [edit]` | show what the tool remembers about this project; `edit` opens `$EDITOR` |
| `/diff` | changes against HEAD, staged included, plus untracked files |
| `/cwd [dir]` | show or change the working directory |
| `/add-dir <dir>` | let the tool write in another directory too |
| `/mention [path\|clear]` (also `/attachments`) | attach a file to the next request; alone, list what is attached; `clear` empties it |

**Provider**

| Command | What it does |
| --- | --- |
| `/provider` (also `/switch`) | choose a provider |
| `/account [label\|login\|add\|remove …]` (also `/accounts`) | switch, add or remove accounts |
| `/login` | sign in to the current provider |
| `/logout` | sign the current account out |
| `/gateway` | route this conversation through ClikDeploy Gateway |

**Settings**

| Command | What it does |
| --- | --- |
| `/model [name]` | choose or set a model |
| `/effort [level]` | reasoning level |
| `/swarm [on\|off]` | swarm for this chat: while on, a task is handed to another of your accounts when it can do it for less, and small ones stay here. Off unless turned on |
| `/fast [on\|off]` | on ClikDeploy Gateway, serve from the fastest provider of the model instead of the cheapest |
| `/permissions [ask\|bypass\|auto]` | approval behavior |
| `/sandbox [on\|off]` | ClikCode's own agent: its shell commands write only the workspace, temp and caches (on by default) |
| `/send [steer\|queue]` | messages typed mid-turn: steer them into the running turn at its next pause (where the agent takes steering; elsewhere they queue, and say so), or queue them for after it. Global; bare `/send` shows the two |
| `/options` | provider-specific modes and controls |
| `/capabilities` | what the selected provider supports |
| `/settings [tools\|route\|account\|model\|effort\|permissions\|option\|global\|provider …]` | configure this workspace. Bare, the settings screen; `tools` goes straight to MCP servers, skills and agents; `option <id> <value\|default>` sets one of the tool's own options; `global <effort\|permissions\|send> <value>` and `provider <id> <model\|effort\|permissions> <value>` (or `provider <id> clear`) set defaults |

**Plan mode** is a row in `/settings`: read-only, plan and change nothing. On
Claude Code and ClikCode's own agent it is kept on the chat until you approve
the plan; GitHub Copilot, Cursor, Cline, Antigravity, Factory Droid (spec mode),
Command Code and Auggie get it as their own option.

**Sessions**

| Command | What it does |
| --- | --- |
| `/sessions [list\|show\|open\|close <id>]` | manage conversations |
| `/resume [name]` | resume another conversation (the board, or straight to the one a name picks out) |
| `/search <words>` | open the conversation that mentions something most, at its first mention: ↑↓ walk the mentions, Tab the next conversation, Esc stays there |
| `/rename [name]` | name this conversation |
| `/fork [@N] [name]` | branch this conversation, or only through your prompt N |
| `/archive` | archive this conversation |
| `/delete [confirm]` | delete this conversation |

**Info**

| Command | What it does |
| --- | --- |
| `/status` | current configuration |
| `/context` | how much of the model's context this conversation is using |
| `/usage [all]` (also `/cost`) | quota, tokens, and cost for the provider you are in, and this chat; `all` for every provider and the last seven days |
| `/doctor` | check your installed tools and accounts |
| `/help` (also `/?`) | all commands |

A command that doesn't apply right now — no provider chosen yet, or a
Gateway-managed setting on the ClikDeploy Gateway route — stays listed with a reason
(`unavailable · …`) instead of disappearing, so the palette always explains
itself.

Three shortcuts are not in the list but work anywhere. Typing a tool's name —
`/claude`, `/codex` — hands the conversation to it, with your next message on
the same line if you want. `//` sends whatever follows straight to the
tool, unchanged, for the occasions when you want its own syntax rather than
ClikCode's. And `!<command>` runs a shell command here, its output going into
the next request.

Some tools bring commands of their own (`/mcp`, `/plugins`, …), and a few
announce more mid-conversation. Those work when typed and appear in `/help`,
but stay out of the list so they don't read as ClikCode's. On ClikCode's own
agent, `/mcp` lists its MCP servers, and `/mcp login <name>` and
`/mcp logout <name>` sign it in and out of one. Your own commands work too:
drop a `*.md` prompt template in `.clikcode/commands/` for this project, or
`~/.clikcode/commands/` for all of them, and it becomes a slash command named
after the file.

## Running without a vendor tool

Everything above assumes the tools are on your machine. When they are not,
sign in to ClikDeploy Gateway instead: it supplies the model, and ClikCode runs
the coding agent itself — same conversations, same commands, no vendor CLI.

Nothing is routed through it until you sign in with `clikcode gateway login`.
The gateway is ClikDeploy Gateway, and it is listed with your other providers.

## What ClikCode keeps, and where

Everything it owns is under `~/.clikcode`, readable only by you (directories
`0700`, files `0600`):

- `index.json` — accounts (labels and credential *references*), the session
  index, usage records and the installation id
- `secrets.json` — the local control API token and this device's key
- `sessions/` — session records and history
- `turn-changes/` — each conversation's per-turn file changes (`/changes`, `/redo`)
- `profiles/<harness>/<account-id>/` — per-account vendor configuration roots
- `runtime.json`, `runtime.lock` — present only while the control API is running
- `crash.log` — uncaught errors

Set `CLIKCODE_HOME` to relocate the state directory (tests, portable installs).
`crash.log` and a gateway credential, if you sign in, always live outside it:
`~/.clikcode/crash.log`, `~/.config/clikcode/auth.json` (or under
`$XDG_CONFIG_HOME`) and `~/.clikcode/api-key`.

## Letting other programs drive it

An editor, a script or another agent can drive ClikCode over a small HTTP API.
`clikcode start` runs it; `clikcode status` and `clikcode stop` inspect and
stop it. It stays off until you start it.

- Binds to `127.0.0.1` only, on an OS-assigned port (or `--port`); the URL is
  printed and recorded in `~/.clikcode/runtime.json`.
- `GET /v1/health` is unauthenticated. Every other route (`/v1/accounts`,
  `/v1/device`, `/v1/models`, `/v1/sessions`, `/v1/usage`, `/v1/chat`) requires
  `Authorization: Bearer <token>`, a per-installation token kept in
  `secrets.json`. Requests whose `Host` is not loopback are refused.
- Responses never contain credential material.

## Tuning and accessibility

Two of these matter even if you set nothing else. `CLIKCODE_SCREEN_READER`
switches to a plain, append-only view that a screen reader announces once and
in order. `CLIKCODE_REDUCED_MOTION` holds the spinner still; the answer still
streams at full speed.

| Variable | Effect |
| --- | --- |
| `CLIKCODE_HOME` | State directory instead of `~/.clikcode` |
| `CLIKCODE_TURN_IDLE_TIMEOUT_MS` | How long a vendor CLI may stay completely silent before the turn is treated as wedged and stopped. Default `600000` (10 minutes). It is an idle timeout, not a cap on turn length |
| `CLIKCODE_REDUCED_MOTION` | Any value other than empty, `0` or `false` holds the spinner on one frame and slows repainting. The turn still streams |
| `NO_MOTION` | Same as `CLIKCODE_REDUCED_MOTION`, used when that is unset |
| `CLIKCODE_SCREEN_READER` | Any value other than empty, `0` or `false` switches to the append-only, line-oriented renderer so output is announced once, in order |
| `CLIKCODE_TUI` | `classic` uses the terminal's native scrollback and a line-oriented prompt if fullscreen rendering misbehaves; `fullscreen` uses the interactive alternate-screen view (the default on capable terminals) |
| `FORCE_COLOR` | `0` disables color; `1`–`3` force a color level |
| `CLIKCODE_OUTPUT_MODE` | `json` or `human`, the same as `--json` / `--human` |
| `CLIKCODE_DEBUG` | `1` is the same as `--debug` |
| `CLIKCODE_GATEWAY_URL` | ClikDeploy Gateway endpoint used by `gateway login` and the gateway route |

## Development

If you want to work on ClikCode itself:

```sh
pnpm install
pnpm build          # dist/index.js (the entry), cli.js, conversations-mcp.js, harness-catalog.cjs, ai-router-runtime.cjs
pnpm build:analyze  # + bundle report: top inputs by bytes, runtime packages
pnpm build:strict   # + fail on a missing or extra runtime dependency
pnpm type-check     # tsc over src/ and over packages/clikrouter
pnpm test           # the ClikCode suite
pnpm test:router    # the router package's suite
pnpm test:all       # both suites
pnpm test:smoke     # build, then --help and doctor against the built binary
pnpm test:pack      # assert tarball contents, npm install -g it into a temp prefix, run it
pnpm test:display   # the terminal UI driven in a real pty: nothing flashes, vanishes or doubles
```

Three packages, one lockfile:

- `src/` — the CLI, one folder per layer: `cli/` (argv, output modes, errors),
  `commands/` (the verbs), `session/` and `turn/` (state and the turn loop),
  `agent/` (ClikCode's own coding agent: tools, permissions, checkpoints),
  `harness/` (driving the vendor CLIs over argv/ACP/app-server),
  `gateway/` (the gateway adapter), `tui/`, `daemon/`, `runtime/`.
- `packages/clikrouter` (`@clikcode/router`) — provider-agnostic request
  normalization and router selection across dozens of providers, consumed as source
  and bundled into `dist/*.cjs`.
- `packages/vscode` — the VS Code extension (`clikcode.clikcode`). It runs the
  installed ClikCode through `clikcode ide-bridge` (`src/ide/`); its own checks are
  `pnpm --dir packages/vscode type-check`, `test`, `run package` and, in a real
  VS Code, `test:integration`.

`dist/cli.js` inlines the small pure-JS dependencies (chalk, commander, conf,
cross-spawn, marked) so startup is a single file read, which is why the
published package declares only the runtime dependencies it loads
(`@huggingface/gguf`, `yaml`) — a property the build asserts rather than
assumes. The version reported by `--version` is
injected at build time from `package.json`.

Releases are published by ClikDeploy, not by hand or by CI: `package.json`
holds MAJOR.MINOR, and ClikDeploy assigns the patch, stamps it, and publishes
to npm with a matching GitHub release (see `packages/vscode/PUBLISHING.md`).

## License

MIT
