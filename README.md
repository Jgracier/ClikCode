# ClikCode

**One terminal for every coding-agent CLI.** Claude Code, Codex, Gemini CLI,
GitHub Copilot, Cursor Agent, OpenCode, Qwen Code and seventeen others each have
their own flags, session stores, permission vocabularies and output formats.
ClikCode drives all 24 through one surface — accounts, sessions, models,
reasoning effort, permissions — so changing tools stops meaning changing habits.

**Sign in once per account, and keep as many accounts as you want.**
Authentication stays inside the vendor's own CLI: ClikCode never reads a token,
it stores an opaque *reference* to a login. Nine of the harnesses can be given a
home of their own, so several subscriptions of the same vendor sit side by side,
each with its own sessions and its own quota.

**Resume any chat, including ones ClikCode never opened.** A conversation is one
row whichever harness answered it, and provider hops live in that row's history
rather than as duplicate sessions. ClikCode also finds threads in the vendors'
own histories — started in Claude Code or Codex directly — and adopts them.

**Keep working past a usage limit.** ClikCode reads each account's remaining
quota and, when a window is exhausted, moves the turn to the next account with
headroom. This is on by default (`accountFailover: on-quota-exhausted`). It
copies the vendor's own session file into that account's profile first, so the
model resumes the actual thread instead of a retelling of it.

Under all of that, ClikCode is a **normalized broker**: every per-vendor fact is
a declared field in one catalog, never a name in a branch, and each vendor keeps
its own authentication and its own interactive managers.

A **hosted gateway** is the optional second route. There, the gateway provides
the intelligence (model selection and inference) and ClikCode itself is the
harness, rather than brokering a vendor CLI. Nothing requires it: without a
gateway sign-in ClikCode works entirely against your local accounts, and
`CLIKCODE_GATEWAY=off` removes the surface altogether. The default endpoint is
ClikDeploy Gateway (`https://clikdeploy.com`) because that is the one that
exists today; `CLIKCODE_GATEWAY_URL` points it anywhere else. Everything the
gateway touches lives in `src/constants.ts` (the switch and the URL) and one
folder, `src/gateway/` (credentials, sign-in, the gateway model harness) — so
replacing it is a local change, not a refactor.

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
| `clikcode doctor` | Installed harness versions and their normalized capabilities |
| `clikcode accounts providers` | Supported harnesses and how each one signs in |
| `clikcode accounts login <harness> [--label <label>]` | Run the vendor's own login into an isolated local account |
| `clikcode accounts list` / `status` / `logout` / `remove` | Manage local account aliases |
| `clikcode models`, `clikcode usage` | Models and usage across local accounts |
| `clikcode sessions list` / `create` / `open` / `resume` / `set` / `close` | Persistent sessions, including resuming the vendor's native chat |
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
