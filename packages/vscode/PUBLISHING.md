# Publishing ClikCode and the VS Code extension

Both artifacts of this repository are published by **ClikDeploy**, automatically. Nobody runs
`npm publish` or `vsce publish` by hand in the normal flow, and this repository has no
GitHub workflow: ClikDeploy runs the whole test gate before it publishes, and a second publisher would
race it for version numbers.

| Artifact | Where | Id |
| --- | --- | --- |
| CLI | npm, plus a GitHub release `v<version>` with `clikcode-<version>.tgz` and `clikcode.tgz` | `clikcode` |
| Extension | Visual Studio Marketplace | `clikcode.clikcode` (publisher and namespace `clikcode`) |

## Tokens

The npm token and the Marketplace personal access token (Azure DevOps, scope *Marketplace → Manage*,
all accessible organizations) live in the **ClikDeploy admin console → Deployments → Build pipeline →
Publishing**. Rotate them there; nothing in this repository holds a token.

## When a release happens

On ClikDeploy's cadence, or at once with **Publish now** in the admin console. A run publishes only
what changed since that artifact's last release:

- **CLI**: everything except `packages/vscode/**` and Markdown.
- **Extension**: everything the CLI counts (it bundles the CLI), plus `packages/vscode/**`, its
  `README.md` and `CHANGELOG.md` included.
- **Neither**: tests and their fixtures and golden files, `packages/vscode/test/`, `bench/`,
  `scripts/tui-e2e/`, `docs/`, `.github/`, `.vscode/`, and lint, editor and vitest configuration.

When both changed, the CLI is published first and the extension after it in the same run, so an
extension never reaches users before the ClikCode it needs.

## Versions

`version` in the root `package.json` and in `packages/vscode/package.json` holds **MAJOR.MINOR**
only; the patch digit in the file is ignored. ClikDeploy computes the patch, stamps the full version
into `package.json` in its own build workspace (never committed back), and publishes that. The CLI
and the extension are versioned independently.

- To start a new release line, bump the minor (or major) here, e.g. `0.1.0` → `0.2.0`.
- Never bump the patch by hand.
- `clikcode --version` prints the stamped version: `scripts/build.mjs` injects `package.json`'s
  version at build time, and `pnpm test:pack` checks the installed binary reports it.

## What ClikDeploy runs

The gate and the publish steps are ClikDeploy's `scripts/deploy/clikcode-publish/build.mjs` and
`publish.mjs`; a run's steps and logs are in its history in the Publishing panel. `.vscodeignore` is
an allowlist: `vsce ls --no-dependencies` shows what the `.vsix` carries.

## Extension ↔ ClikCode compatibility

The extension runs the user's installed ClikCode (`clikcode ide-bridge`) when there is one, and the
copy it ships with (`bundled/clikcode`, staged by `scripts/package.mjs` from the repository's `dist`
plus the runtime packages `dist` imports, each bundled into one file so the package stays well
under vsce's 100-JavaScript-file warning) only when there is none. The order matters: a worker is
retired by any client whose build differs, so two builds in play on one machine would retire each
other's workers. Test the shipped shape with `CLIKCODE_IT_BUNDLED=1 CLIKCODE_IT_EXTENSION_PATH=<an
unpacked .vsix> xvfb-run -a pnpm run test:integration` (no `clikcode.path`, no `clikcode` on PATH).
The bridge protocol's version and the oldest one the extension accepts are in one place,
`src/ide/protocol-version.ts`; the bridge sends its version in the `ready` event and the extension
checks it (`packages/vscode/src/compat.ts`):

- ClikCode too old (no `ide-bridge`, or an older protocol): the chat shows **Update ClikCode**, which
  runs `npm install -g clikcode@latest` (the GitHub release tgz is offered as the fallback).
- ClikCode newer than the extension knows: the chat shows **Update Extension**.

Bump `IDE_PROTOCOL.version` only for a change an older extension cannot handle; new optional fields
and new event types need no bump.

## Before a release reaches users

Worth doing locally for a change to the extension:

```sh
pnpm install
node scripts/build.mjs                                  # ClikCode itself, for the integration test
xvfb-run -a pnpm --dir packages/vscode test:integration # real VS Code, real turns (drop xvfb-run with a display)
```

Keep a `CHANGELOG.md` entry per release line. The README screenshot is served from
`https://raw.githubusercontent.com/Jgracier/ClikCode/main/packages/vscode/media/screenshots/turn.png`,
which works because the repository is public.

## Manual fallback

Only if ClikDeploy cannot publish, and never while it is publishing the same artifact. Pick a
version above the latest published one (`npm view clikcode version`; the Marketplace listing for the
extension), stamp it locally without committing it, and:

```sh
# CLI, from the repository root
npm pkg set version=<version>
pnpm build && pnpm test:pack
npm publish --access public --//registry.npmjs.org/:_authToken=<npm-token>
gh release create v<version> clikcode-<version>.tgz clikcode.tgz --title "ClikCode <version>"
git checkout package.json

# Extension
cd packages/vscode
npm pkg set version=<version>
pnpm run package                                    # -> clikcode-<version>.vsix
VSCE_PAT=<marketplace-token> ./node_modules/.bin/vsce publish --no-dependencies --packagePath clikcode-<version>.vsix
git checkout package.json
```

For the release assets, `npm pack` produces `clikcode-<version>.tgz`; copy it to `clikcode.tgz` as
well (the name `releases/latest/download/clikcode.tgz` resolves to).

Listings: <https://www.npmjs.com/package/clikcode>,
<https://marketplace.visualstudio.com/items?itemName=clikcode.clikcode>.
