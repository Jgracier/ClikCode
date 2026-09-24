# ClikCode

**The terminal harness that logs in all your favorite AI coding providers.** Chats you can resume in any of them, and automatic account switching when you hit a usage limit.

Claude Code for one thing, Codex for another, Copilot because it came with the
editor, something you tried once and kept. Each has its own commands, its own
sign-in, its own idea of where your conversations live. None of them know the
others exist, so picking one up means learning it again and leaving your work
behind in the last one.

ClikCode sits in front of 24 of them. One sign-in, one list of conversations, one
set of controls, the same keystrokes whichever tool answers. It replaces
nothing — your tools stay yours, the logins you already had keep working — and
what it adds is this:

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
npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz
```

Requires **Node.js 22.12 or newer**. Nothing to configure. You do not need any
of the coding tools installed first — where a vendor ships an installable CLI,
ClikCode installs it for you on first sign-in.

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
| **←** | Back, one level |
| **↑ ↓** | Move through a list; in an empty composer, your previous messages |
| **Enter** | Send, or confirm the highlighted row |
| **Tab** | Complete the highlighted command |
| **Delete** | In a picker, the destructive action on a row — remove an account, delete a conversation |
| **Esc** | Stop the current answer, keeping what you typed (if you have scrolled back, the first press returns to the live end). Closes the command list and clears its filter |
| **Ctrl+C** | Stop the answer. On a draft, clears it; twice within two seconds exits |
| **Ctrl+D** | Exit, on an empty line |
| **Ctrl+Z** | Drop to a shell; `fg` brings you back |
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
ClikCode points the tool at it using that vendor's own supported setting —
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`,
`QWEN_HOME` and so on — for
one child process at a time. Nothing global changes, and the `~/.claude`,
`~/.codex` logins you already had are untouched.

Nine tools work this way today: Claude Code, Codex, GitHub Copilot, Gemini
CLI, Qwen Code, Antigravity, Pi, Hermes and Command Code. The rest hold one
account each — usually an API key — added with `clikcode accounts add`.

Two of the nine, Antigravity and Command Code, have no such setting, so
ClikCode points `HOME` elsewhere for that one process instead. On its own that
would also hide your git, npm, GitHub CLI, Docker, GnuPG, Cargo, rustup and ssh-agent
configuration from the agent, so ClikCode points those back at your real home.
Turns still commit, push and install as you.

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

This is on by default. Turn it off for the current conversation with
`/accounts failover never`, or for a new one with
`clikcode sessions create --account-failover never`.

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
vendor can read another vendor's memory, so the new tool is sent the
conversation so far as context. On a long thread that costs tokens and a few
seconds. Nothing else changes.

## One MCP server, every tool

Tools that support MCP each want it configured their own way. Add a server
once and ClikCode installs it into all of them, in each one's spelling:

```sh
clikcode mcp targets                        # who would receive it, and how
clikcode mcp add postgres -- npx -y pg-mcp  # send it to all of them
```

ClikCode does not host or proxy these servers. Each tool talks to them
directly, exactly as it would if you had configured it by hand.

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
| `clikcode models`, `clikcode usage` | Models you can pick, and how much each account has left |
| `clikcode sessions list` / `show` / `create` / `open` / `resume` / `send` / `set` / `close` | Your conversations, including ones a tool started on its own |
| `clikcode permissions [ask\|bypass\|auto]` | Approval behavior for the active chat |
| `clikcode gateway login [--github]` / `gateway status` | ClikDeploy Gateway sign-in (Google by default) |

Output is JSON when it is not going to a terminal, so ClikCode scripts
cleanly, and readable text when it is. `--json` or `--human` forces one, and
`--debug` adds the stack and HTTP detail when something fails.

## Inside a session

Most of the time you will not type any of those. You will be in a session,
where everything is a slash away.

Pressing `/` opens a searchable list. Six are pinned at the top, in the order
people reach for them: pick a tool, pick an account on it, resume a
conversation, change the model, start over, change what needs your approval.

| Command | What it does |
| --- | --- |
| `/provider` | choose a provider |
| `/account [label]` | switch accounts |
| `/resume` | resume another conversation |
| `/model [name]` | choose or set a model |
| `/new [first message]` | start a fresh conversation (the current one stays resumable) |
| `/permissions [ask\|bypass\|auto]` | approval behavior |

`/help` lists every command grouped by topic instead of by frequency, since a
reference reads better that way. The remaining ~35 commands, grouped as
`/help` groups them:

**Conversation**

| Command | What it does |
| --- | --- |
| `/new [first message]` (also `/clear`, `/reset`) | start a fresh conversation (the current one stays resumable) |
| `/compact [focus]` | summarize the conversation and continue in a fresh native session |
| `/history` | show this conversation |
| `/copy` | copy the last answer |
| `/export [path]` | write the transcript as markdown |
| `/undo` | revert the last turn (only where the vendor exposes it) |
| `/native <text>` (also `//text`) | send text straight to the tool, unchanged |
| `/select` | release the mouse so you can select and copy text |
| `/redraw` | repaint the screen |
| `/exit` (also `/quit`) | save and leave |

**Workspace**

| Command | What it does |
| --- | --- |
| `/review [focus]` | ask the provider to review uncommitted changes |
| `/init` | create or improve the tool's own instructions file for this project |
| `/memory [edit]` | show what the tool remembers about this project; `edit` opens `$EDITOR` |
| `/diff` | changes against HEAD, staged included, plus untracked files |
| `/cwd [dir]` | show or change the working directory |
| `/add-dir <dir>` | let the tool write in another directory too |
| `/mention [path]` | attach a file to the next request |
| `/attachments [clear]` | queued files; `clear` empties them |

**Provider**

| Command | What it does |
| --- | --- |
| `/provider` (also `/switch`, `/engine`) | choose a provider |
| `/account [label]` | switch accounts |
| `/accounts [use\|login\|add\|remove\|failover auto\|never]` | list and manage accounts |
| `/login` | sign in to the current provider |
| `/logout` | sign the current account out |
| `/gateway` | route this conversation through ClikDeploy Gateway |

**Settings**

| Command | What it does |
| --- | --- |
| `/model [name]` | choose or set a model |
| `/models` | list models configured on local accounts |
| `/effort [level]` | reasoning level |
| `/permissions [ask\|bypass\|auto]` | approval behavior |
| `/options` | provider-specific modes and controls |
| `/capabilities` | what the selected provider supports |
| `/settings [route\|account\|model\|effort\|permissions\|option\|global\|provider …]` | configure this workspace |

**Sessions**

| Command | What it does |
| --- | --- |
| `/sessions [list\|show\|open\|close <id>]` | manage conversations |
| `/resume` | resume another conversation |
| `/rename [name]` | name this conversation |
| `/fork [name]` | branch this conversation |
| `/archive` | archive this conversation |
| `/delete [confirm]` | delete this conversation |

**Info**

| Command | What it does |
| --- | --- |
| `/status` | current configuration |
| `/context` | how much of the model's context this conversation is using |
| `/usage` | quota, tokens, and cost for the provider you are in (`/cost` is the same command) |
| `/usage` | token usage for this account |
| `/doctor` | check your installed tools and accounts |
| `/help` (also `/?`) | all commands |

A command that doesn't apply right now — no provider chosen yet, or a
Gateway-managed setting on the ClikDeploy Gateway route — stays listed with a reason
(`unavailable · …`) instead of disappearing, so the palette always explains
itself.

Two shortcuts are not in the list but work anywhere. Typing a tool's name —
`/claude`, `/codex` — hands the conversation to it, with your next message on
the same line if you want. And `//` sends whatever follows straight to the
tool, unchanged, for the occasions when you want its own syntax rather than
ClikCode's.

Some tools bring commands of their own (`/mcp`, `/plugins`, …), and a few
announce more mid-conversation. Those work when typed and appear in `/help`,
but stay out of the pinned list so they don't read as ClikCode's. So do your
own: drop a `*.md` prompt template in `.clikcode/commands/` for this project,
or `~/.clikcode/commands/` for all of them, and it becomes a slash command
named after the file.

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
| `FORCE_COLOR` | `0` disables color; `1`–`3` force a color level |
| `CLIKCODE_OUTPUT_MODE` | `json` or `human`, the same as `--json` / `--human` |
| `CLIKCODE_DEBUG` | `1` is the same as `--debug` |
| `CLIKCODE_GATEWAY_URL` | ClikDeploy Gateway endpoint used by `gateway login` and the gateway route |

## Development

If you want to work on ClikCode itself:

```sh
pnpm install
pnpm build          # dist/index.js, dist/harness-catalog.cjs, dist/ai-router-runtime.cjs
pnpm build:analyze  # + bundle report: top inputs by bytes, runtime packages
pnpm build:strict   # + fail on a missing or extra runtime dependency
pnpm type-check     # tsc over src/ and over packages/clikrouter
pnpm test           # the ClikCode suite
pnpm test:router    # the router package's suite
pnpm test:smoke     # build, then --help and doctor against the built binary
pnpm test:pack      # assert tarball contents, install it in a temp dir, run it
```

Two packages, one lockfile:

- `src/` — the CLI, one folder per layer: `cli/` (argv, output modes, errors),
  `commands/` (the verbs), `session/` and `turn/` (state and the turn loop),
  `agent/` (ClikCode's own coding agent: tools, permissions, checkpoints),
  `harness/` (driving the vendor CLIs over argv/ACP/app-server),
  `gateway/` (the gateway adapter), `tui/`, `daemon/`, `runtime/`.
- `packages/clikrouter` (`@clikcode/router`) — provider-agnostic request
  normalization and router selection across dozens of providers, consumed as source
  and bundled into `dist/*.cjs`.

`dist/index.js` inlines the small pure-JS dependencies (chalk, commander, conf,
cross-spawn, marked) so startup is a single file read, which is why the
published package declares a single runtime dependency (`yaml`) — a property
the build asserts rather than assumes. The version reported by `--version` is
injected at build time from `package.json`.

## License

MIT
