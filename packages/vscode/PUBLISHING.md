# Publishing the ClikCode VS Code extension

Nothing here has been published. The publisher id and both access tokens are yours to create;
this is the whole procedure, in order.

## 0. Before the first release

1. **Choose the publisher id.** `package.json` has `"publisher": "clikcode"` as a placeholder.
   Replace it with the id you create in step 1 (Marketplace ids are global and first-come; if
   `clikcode` is free, keep it). The extension's full id becomes `<publisher>.clikcode`.
2. **README images.** The screenshot is linked as
   `https://raw.githubusercontent.com/Jgracier/ClikCode/main/packages/vscode/media/screenshots/chat.png`.
   It shows on the Marketplace only if the GitHub repository is public. If it is private, host the
   image somewhere public and change the link in `README.md`.
3. Bump `version` in `package.json` and add a `CHANGELOG.md` entry for every later release.

## 1. Build and check the package

From the repository root:

```sh
pnpm install
node scripts/build.mjs                       # ClikCode itself, for the integration test
cd packages/vscode
pnpm run type-check
pnpm test                                    # unit tests
xvfb-run -a pnpm run test:integration        # real VS Code, real turns (drop xvfb-run with a display)
pnpm run package                             # -> packages/vscode/clikcode-<version>.vsix
./node_modules/.bin/vsce ls --no-dependencies
```

`vsce ls` must list exactly: `CHANGELOG.md`, `LICENSE`, `README.md`, `package.json`,
`dist/extension.js`, `dist/webview.js`, `media/activity.svg`, `media/editor-light.svg`, `media/editor-dark.svg`, `media/chat.css`, `media/icon.png`.

Optional smoke test of the .vsix in your own VS Code:

```sh
code --install-extension clikcode-<version>.vsix
code --list-extensions --show-versions | grep clikcode
```

## 2. Visual Studio Marketplace

1. Sign in at <https://dev.azure.com> with the Microsoft account that will own the extension and
   create an organization if you have none.
2. Create a Personal Access Token: *User settings → Personal access tokens → New Token*.
   Organization: **All accessible organizations**. Scopes: *Custom defined → Marketplace →
   **Manage***. Copy the token.
3. Create the publisher at <https://marketplace.visualstudio.com/manage/createpublisher> with the
   id you put in `package.json`.
4. Publish the package you tested:

   ```sh
   cd packages/vscode
   ./node_modules/.bin/vsce login <publisher>           # paste the token when asked
   ./node_modules/.bin/vsce publish --no-dependencies --packagePath clikcode-<version>.vsix
   ```

   Or without storing the token: `VSCE_PAT=<token> ./node_modules/.bin/vsce publish --no-dependencies --packagePath clikcode-<version>.vsix`.
5. The listing appears at `https://marketplace.visualstudio.com/items?itemName=<publisher>.clikcode`
   after verification (usually minutes).

## 3. Open VSX (VSCodium, Cursor, Windsurf, Gitpod, …)

1. Sign in at <https://open-vsx.org> with GitHub and accept the Eclipse Foundation Open VSX
   Publisher Agreement (profile settings; this needs an eclipse.org account linked to GitHub).
2. Create an access token at <https://open-vsx.org/user-settings/tokens>.
3. Create the namespace once — it must equal the `publisher` field:

   ```sh
   cd packages/vscode
   ./node_modules/.bin/ovsx create-namespace <publisher> -p <open-vsx-token>
   ```

4. Publish the same .vsix:

   ```sh
   ./node_modules/.bin/ovsx publish clikcode-<version>.vsix -p <open-vsx-token>
   ```

5. Optional: claim namespace ownership (the "verified" badge) by opening an issue at
   <https://github.com/EclipseFdn/open-vsx.org/issues> as the docs describe.

## 4. After publishing

- Tag the release: `git tag vscode-v<version> && git push origin vscode-v<version>`.
- Users still need ClikCode itself (`npm install -g https://github.com/Jgracier/ClikCode/releases/latest/download/clikcode.tgz`);
  the extension offers that install when it is missing. An extension release that relies on a new
  `ide-bridge` capability should go out after the ClikCode release that ships it.
