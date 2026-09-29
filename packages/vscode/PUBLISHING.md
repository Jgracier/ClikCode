# Publishing ClikCode and the VS Code extension

Both artifacts of this repository are published by **ClikDeploy**, automatically. Nobody runs
`npm publish`, `vsce publish` or `ovsx publish` by hand in the normal flow, and the GitHub workflow
(`.github/workflows/test.yml`) only tests: a second publisher would race ClikDeploy for version
numbers.

| Artifact | Where | Id |
| --- | --- | --- |
| CLI | npm, plus a GitHub release `v<version>` with `clikcode-<version>.tgz` and `clikcode.tgz` | `clikcode` |
| Extension | Visual Studio Marketplace and Open VSX | `clikcode.clikcode` (publisher and namespace `clikcode`) |

## Tokens

The npm token, the Marketplace personal access token (Azure DevOps, scope *Marketplace → Manage*,
all accessible organizations) and the Open VSX access token live in the **ClikDeploy admin console →
Resources → Platform**. Rotate them there; nothing in this repository holds a token.

## When a release happens

On ClikDeploy's cadence, or at once with **Publish now** in the admin console. A run publishes only
what changed since that artifact's last release:

- **Extension**: `packages/vscode/**`, `src/ide/**`, `src/worker/protocol.ts`.
- **CLI**: everything else except `*.md` (and except `packages/vscode/**`).

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

CLI, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm type-check
pnpm test:all
pnpm build:strict
pnpm test:pack          # packs, npm install -g's the tarball into a clean prefix, runs
                        # clikcode --version, --help, ide-bridge --help and doctor
# stamp the version into package.json, then:
npm publish --access public
# then the GitHub release v<version> with clikcode-<version>.tgz and clikcode.tgz
```

Extension:

```sh
pnpm --dir packages/vscode type-check
pnpm --dir packages/vscode test
pnpm --dir packages/vscode run package    # must print no warnings
# stamp the version into packages/vscode/package.json, package again, then:
vsce publish --no-dependencies --packagePath clikcode-<version>.vsix
ovsx publish clikcode-<version>.vsix
```

`vsce ls --no-dependencies` must list exactly: `CHANGELOG.md`, `LICENSE`, `README.md`,
`package.json`, `dist/extension.js`, `dist/webview.js`, `media/activity.svg`, `media/chat.css`,
`media/editor-dark.svg`, `media/editor-light.svg`, `media/icon.png` (`.vscodeignore` is an
allowlist).

## Extension ↔ ClikCode compatibility

The extension runs the user's installed ClikCode (`clikcode ide-bridge`), never a bundled copy. The
bridge protocol's version and the oldest one the extension accepts are in one place,
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
version above the latest published one (`npm view clikcode version`; the Marketplace and Open VSX
listings for the extension), stamp it locally without committing it, and:

```sh
# CLI, from the repository root
npm pkg set version=<version>
pnpm build:strict && pnpm test:pack
npm publish --access public --//registry.npmjs.org/:_authToken=<npm-token>
gh release create v<version> clikcode-<version>.tgz clikcode.tgz --title "ClikCode <version>"
git checkout package.json

# Extension
cd packages/vscode
npm pkg set version=<version>
pnpm run package                                    # -> clikcode-<version>.vsix
VSCE_PAT=<marketplace-token> ./node_modules/.bin/vsce publish --no-dependencies --packagePath clikcode-<version>.vsix
./node_modules/.bin/ovsx publish clikcode-<version>.vsix -p <open-vsx-token>
git checkout package.json
```

For the release assets, `npm pack` produces `clikcode-<version>.tgz`; copy it to `clikcode.tgz` as
well (the name `releases/latest/download/clikcode.tgz` resolves to).

Listings: <https://www.npmjs.com/package/clikcode>,
<https://marketplace.visualstudio.com/items?itemName=clikcode.clikcode>,
<https://open-vsx.org/extension/clikcode/clikcode>.
