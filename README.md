# ClikCode

You have five AI coding tools installed and none of them know about each
other. ClikCode is the one place they all answer from.

**Every tool, one way of working.** Claude Code, Codex, Gemini, Copilot,
Cursor and nineteen more. Each arrived with its own commands, its own sign-in,
its own idea of where your chats live. ClikCode gives you one of each — and the
controls stay in the same place no matter which one is answering.

**All your accounts, at once.** You still sign in inside the tool itself, the
way you always have; ClikCode never sees your password or your key. It just
remembers which account is which. Work and personal, two subscriptions, a spare
— keep them side by side and move between them in a keystroke. (Nine of the
tools can hold several accounts this way, Claude Code, Codex, Copilot and
Gemini among them.)

**One list of conversations.** Not one per tool. Whichever one you were using
when you started a chat, it is in the same list, and you can carry it on
somewhere else. Chats you began in Claude Code or Codex directly, long before
ClikCode was involved, are in that list too.

**Run out, and keep going.** When an account hits its limit, ClikCode moves to
the next one and the answer keeps coming. It takes the conversation with it, so
the model continues from what was actually said rather than a summary of it.
Nothing to click. You find out afterwards.

Underneath, ClikCode is a translator. Everything it knows about a tool is
written down as description rather than built into the code, which is why
adding the twenty-fifth one is a paragraph and not a project.

Sign in to a **hosted service** instead and ClikCode will do the thinking
itself, no vendor tool required. That route is entirely optional — leave it
alone and ClikCode works purely against the accounts on your machine.
[Details below](#the-optional-gateway).

## Install

```sh
npm install -g clikcode
clikcode            # open the default session
clikcode --help
```

Requires **Node.js 22.12 or newer**. The vendor CLIs themselves are installed on
demand by `clikcode accounts login <harness>` when they support it.

## Everyday commands

| Command | What it does |
| --- | --- |
| `clikcode` | Open (or resume) the default interactive session |
| `clikcode doctor` | Which tools are installed, their versions and what each can do |
| `clikcode accounts providers` | Every supported tool and how it signs in |
| `clikcode accounts login <tool> [--label <label>]` | Run that tool's own login, kept separate from your others |
| `clikcode accounts list` / `status` / `logout` / `remove` | Your accounts: what they are called, and what is left on each |
| `clikcode models`, `clikcode usage` | Models you can pick, and how much each account has left |
| `clikcode sessions list` / `create` / `open` / `resume` / `set` / `close` | Your conversations, including ones a tool started on its own |
| `clikcode permissions [ask\|bypass\|auto]` | Approval behavior for the active chat |
| `clikcode gateway login [--github]` / `gateway status` | Optional gateway sign-in (Google by default); absent when `CLIKCODE_GATEWAY=off` |

Output is JSON by default so ClikCode can be scripted; pass `--human` for
readable output and `--debug` for stack traces and HTTP detail on failure.

## In-session commands

Inside an open session, typing `/` opens a command palette. The six commands
worth reaching without scrolling are pinned to the top, in the order they get
used: pick a provider, pick an account on it, resume a conversation, change
the model, then the two used mid-conversation more than anything else —
starting over and changing what needs approval:

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
| `/native <text>` (also `//text`) | send text to the harness verbatim |
| `/redraw` | repaint the screen |
| `/exit` (also `/quit`) | save and leave |

**Workspace**

| Command | What it does |
| --- | --- |
| `/review [focus]` | ask the provider to review uncommitted changes |
| `/init` | create or improve the harness's agent instructions file |
| `/memory [edit]` | show the harness's memory file; `edit` opens `$EDITOR` |
| `/diff` | changes against HEAD, staged included, plus untracked files |
| `/cwd [dir]` | show or change the working directory |
| `/add-dir <dir>` | give the harness another writable directory |
| `/mention [path]` | attach a file to the next request |
| `/attachments [clear]` | queued files; `clear` empties them |

**Provider**

| Command | What it does |
| --- | --- |
| `/provider` (also `/switch`, `/engine`) | choose a provider |
| `/account [label]` | switch accounts |
| `/accounts [use\|login\|add\|remove\|failover …]` | list and manage accounts |
| `/login` | sign in to the current provider |
| `/logout` | sign the current account out |
| `/gateway` | route this conversation through the optional gateway |

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
| `/context` | context window and token usage reported by the harness |
| `/cost` | tokens and cost for this conversation |
| `/usage` | token usage for this account |
| `/doctor` | check installed harnesses and accounts |
| `/help` (also `/?`) | all commands |

A command that doesn't apply right now — no provider chosen yet, or a
Gateway-managed setting on the Gateway route — stays listed with a reason
(`unavailable · …`) instead of disappearing, so the palette always explains
itself.

Two more surfaces are reachable by name but not listed above: `/<harness>`
(for example `/claude`, `/codex`) hands the conversation off to another
provider, optionally with a first request, and `//<text>` sends a line to the
harness verbatim. If a harness contributes its own manager commands (`/mcp`,
`/plugins`, …) or an ACP agent advertises commands mid-session, those run when
typed and appear in `/help`, but stay out of the palette so they don't read as
ClikCode's own. User-defined commands — `*.md` prompt templates under
`.clikcode/commands/` (workspace) or `~/.clikcode/commands/` (home) — show up
the same way.

## Where state lives

Everything ClikCode owns is under `~/.clikcode` (directories `0700`, files
`0600`):

- `harness-state.json` — accounts (labels and credential *references*), session
  index, usage records, the installation id
- `sessions/` — session history
- `profiles/<harness>/<account-id>/` — per-account vendor configuration roots
- `runtime.json`, `runtime.lock` — present only while the control API is running
- `crash.log` — uncaught errors

Set `CLIKCODE_HOME` to relocate all of it (tests, portable installs). A gateway
credential, if you sign in, is stored separately in `~/.config/clikcode/auth.json`
and `~/.clikcode/api-key`. A credential left behind by the ClikDeploy CLI
(`~/.config/clikdeploy/auth.json`, `~/.clikdeploy/api-key`) is still read, so an
existing sign-in keeps working; the next write moves it.

## Account isolation

Several accounts for the same vendor can coexist. Each account gets its own
directory under `~/.clikcode/profiles/`, and ClikCode points the vendor CLI at it
through that vendor's *own supported* configuration variable — for example
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `QWEN_HOME` — for that one
child process only. Nothing global is changed, and your ordinary
`~/.claude`, `~/.codex`, … logins are untouched.

A few CLIs have no such variable and are isolated by redirecting `HOME` for the
child process. Because that would also hide your git, npm, GitHub CLI, Docker,
GnuPG, Cargo and ssh-agent configuration from the agent's tools, ClikCode points
those back at your real home so turns still commit, push and install as you.

Switching account mid-session is explicit (`/accounts`), and automatic failover
to another account happens only on a recognized quota-exhaustion failure and only
if the session opted in (`--account-failover on-quota-exhausted`).

## The optional gateway

The second route is a hosted one. There, the service supplies the model and
ClikCode runs the coding agent itself, rather than driving a vendor's CLI — so
it works on a machine with none of those tools installed.

Nothing requires it. Without a gateway sign-in ClikCode works entirely against
your local accounts, and `CLIKCODE_GATEWAY=off` removes the commands
altogether. The default endpoint is ClikDeploy Gateway
(`https://clikdeploy.com`) because that is the one that exists today;
`CLIKCODE_GATEWAY_URL` points it anywhere else. Everything the gateway touches
lives in `src/constants.ts` (the switch and the URL) and one folder,
`src/gateway/`, so replacing it is a local change rather than a refactor.

## Optional loopback control API

`clikcode start` runs a small HTTP API for local tools; `clikcode status` and
`clikcode stop` inspect and stop it. It is off unless you start it.

- Binds to `127.0.0.1` only, on an OS-assigned port (or `--port`); the URL is
  printed and recorded in `~/.clikcode/runtime.json`.
- `GET /v1/health` is unauthenticated. Every other route (`/v1/accounts`,
  `/v1/device`, `/v1/models`, `/v1/sessions`, `/v1/usage`, `/v1/chat`) requires
  `Authorization: Bearer <token>`, a per-installation token kept in
  `harness-state.json`.
- Responses never contain credential material.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CLIKCODE_HOME` | State directory instead of `~/.clikcode` |
| `CLIKCODE_TURN_IDLE_TIMEOUT_MS` | How long a vendor CLI may stay completely silent before the turn is treated as wedged and stopped. Default `600000` (10 minutes). It is an idle timeout, not a cap on turn length |
| `CLIKCODE_REDUCED_MOTION` | Any value other than empty, `0` or `false` holds the spinner on one frame and slows repainting. The turn still streams |
| `NO_MOTION` | Same as `CLIKCODE_REDUCED_MOTION`, used when that is unset |
| `CLIKCODE_SCREEN_READER` | Any value other than empty, `0` or `false` switches to the append-only, line-oriented renderer so output is announced once, in order |
| `FORCE_COLOR` | `0` disables color; `1`–`3` force a color level |
| `CLIKCODE_GATEWAY` | `off`, `0`, `false` or `no` removes the optional gateway command surface entirely |
| `CLIKCODE_GATEWAY_URL` | Gateway endpoint used by `gateway login` and the gateway route (default `https://clikdeploy.com`). `CLIKDEPLOY_API_URL` is still honoured |

## Development

```sh
pnpm install
pnpm build          # dist/index.js, dist/harness-catalog.cjs, dist/ai-router-runtime.cjs
pnpm build:analyze  # + bundle report: top inputs by bytes, runtime packages
pnpm build:strict   # + fail if a deployment-shaped source lands in dist/index.js
pnpm type-check     # tsc over src/ and over packages/clikrouter
pnpm test           # the ClikCode suite
pnpm test:router    # the router package's suite
pnpm test:smoke     # build, then --help and doctor against the built binary
pnpm test:pack      # assert tarball contents, install it in a temp dir, run it
```

Two packages, one lockfile:

- `src/` — the CLI, one folder per layer: `cli/` (argv, output modes, errors),
  `commands/` (the verbs), `session/` and `turn/` (state and the turn loop),
  `agent/` (ClikCode's own harness: tools, permissions, checkpoints),
  `harness/` (driving external vendor CLIs over argv/ACP/app-server),
  `gateway/` (the optional adapter), `tui/`, `daemon/`, `runtime/`.
- `packages/clikrouter` (`@clikcode/router`) — provider-agnostic request
  normalization and router selection across ~40 providers, consumed as source
  and bundled into `dist/*.cjs`.

`dist/index.js` inlines the small pure-JS dependencies (chalk, commander, conf,
cross-spawn, marked) so startup is a single file read, which is why the
published package declares **no runtime dependencies at all** — a property the
build asserts rather than assumes. The version reported by `--version` is
injected at build time from `package.json`.

### Provenance

This repository was split out of the ClikDeploy monorepo with
`git filter-repo`, so `git log` on any file predates the split. `build:strict`
still fails on a source named the way that monorepo named its deployment-only
modules (`server-*`, `deploy*`, `docker*`, `admin-*`); nothing matching one
exists here, and the check stays as a tripwire.

## License

MIT
