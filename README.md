# ClikCode

ClikCode is a local-first coding runtime that acts as a **normalized broker for
vendor coding-agent harnesses**. Claude Code, Codex, GitHub Copilot, OpenCode,
Qwen Code and the other supported CLIs each have their own flags, session
stores, permission vocabularies and output formats. ClikCode drives them through
one surface — accounts, sessions, models, reasoning effort, permissions — while
leaving authentication and each vendor's interactive managers in the vendor's
own CLI. Provider credentials never leave your machine and are never read by
ClikCode: it stores an opaque *reference* to a login, not a token.

**ClikDeploy Gateway** is the optional second route. There, ClikDeploy provides
the intelligence (model selection and inference) and ClikCode itself is the
harness, rather than brokering a vendor CLI. Nothing requires it; without a
Gateway sign-in ClikCode works entirely against your local accounts.

## Install

```sh
npm install -g @clikdeploy/clikcode
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
| `clikcode gateway login [--github]` / `gateway status` | Optional ClikDeploy Gateway sign-in (Google by default) |

Output is JSON by default so ClikCode can be scripted; pass `--human` for
readable output and `--debug` for stack traces and HTTP detail on failure.

## Where state lives

Everything ClikCode owns is under `~/.clikcode` (directories `0700`, files
`0600`):

- `harness-state.json` — accounts (labels and credential *references*), session
  index, usage records, the installation id
- `sessions/` — session history
- `profiles/<harness>/<account-id>/` — per-account vendor configuration roots
- `runtime.json`, `runtime.lock` — present only while the control API is running
- `crash.log` — uncaught errors

Set `CLIKCODE_HOME` to relocate all of it (tests, portable installs). A
ClikDeploy Gateway credential, if you sign in, is stored separately in the
ClikDeploy location (`~/.config/clikdeploy/auth.json`, `~/.clikdeploy/api-key`)
so it is shared with the ClikDeploy CLI.

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
| `CLIKDEPLOY_API_URL` | ClikDeploy platform URL used by `gateway login` and the Gateway route (default `https://clikdeploy.com`) |

## Development

```sh
pnpm --filter @clikdeploy/clikcode build          # dist/index.js, dist/harness-catalog.cjs, dist/ai-router-runtime.cjs
pnpm --filter @clikdeploy/clikcode build:analyze  # + bundle report: top inputs by bytes, runtime packages
pnpm --filter @clikdeploy/clikcode build:strict   # + fail if deployment-CLI sources are in dist/index.js
pnpm --filter @clikdeploy/clikcode type-check     # tsc over src/ and everything it imports
pnpm --filter @clikdeploy/clikcode test           # build, then --help and doctor
pnpm --filter @clikdeploy/clikcode test:pack      # assert tarball contents, install it in a temp dir, run it
```

The implementation is shared with `apps/cli/src` during extraction; esbuild
bundles it, so the published package has no dependency on `clikdeploy-cli`.
`dist/index.js` inlines the small pure-JS dependencies (chalk, commander, conf,
cross-spawn, marked) so startup is a single file read. The version reported by
`--version` is injected at build time from this package's `package.json`.

`build:strict` is opt-in for now: `apps/cli/src/commands/ai.ts` still imports
the deployment API client and login command, which drag the self-host server
tree into the bundle. Once it imports `commands/gateway-credentials.ts` and
`commands/gateway-login.ts` instead, make `--strict` part of `build`.

## License

MIT
