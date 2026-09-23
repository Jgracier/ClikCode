/**
 * How to install a harness that does not publish an npm package.
 *
 * "X does not publish an npm package ClikCode can install automatically" was
 * a dead end: true, and no help. These vendors do ship installers, just not
 * through npm.
 *
 * ClikCode does not run them. Every one is a `curl | bash` or a pip install
 * from a third party, and silently executing one on the user's machine
 * because they opened a provider list is not a decision this program gets to
 * make for them. The command is shown, with its source, and the user runs it.
 *
 * Only commands read from the vendor's own documentation appear here. An
 * entry with `docs` but no `command` means the install exists but was not
 * verified well enough to print as something to paste -- checked for Goose,
 * whose README gave a release URL under a different org than its own
 * repository, which is exactly the kind of thing not to hand someone as a
 * command to run.
 */

interface HarnessInstallHint {
  /** Verbatim from the vendor's own docs, with `source` naming where. */
  command?: string;
  /** Where to read the vendor's install instructions. */
  docs: string;
  /** The page the command was taken from. */
  source?: string;
}

export const HARNESS_INSTALL_HINTS: Readonly<Record<string, HarnessInstallHint>> = {
  cursor: {
    command: 'curl https://cursor.com/install -fsS | bash',
    docs: 'https://cursor.com/docs/cli/installation',
    source: 'https://cursor.com/docs/cli/installation',
  },
  aider: {
    command: 'python -m pip install aider-install && aider-install',
    docs: 'https://aider.chat/docs/install.html',
    source: 'https://github.com/Aider-AI/aider README',
  },
  goose: {
    // block/goose now redirects to aaif-goose/goose: the project was moved,
    // not forked (same 54k-star repository, homepage goose-docs.ai), which is
    // why the release URL names an org the docs do not.
    command: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
    docs: 'https://goose-docs.ai/',
    source: 'https://github.com/aaif-goose/goose README',
  },
  openhands: {
    command: 'uv tool install openhands --python 3.12',
    docs: 'https://docs.openhands.dev/usage/local-setup',
    source: 'https://docs.openhands.dev/usage/local-setup',
  },
  vibe: {
    command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    docs: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
    source: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
  },
  hermes: {
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    docs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    source: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
  },
  // Kiro publishes downloads, not a scriptable installer: its own install page
  // lists supported platforms and links a downloads page, with no command to
  // quote. Antigravity's CLI ships with the Antigravity editor rather than
  // separately. Neither gets an invented command.
  kiro: {
    // Ran it: installs a `kiro-cli` binary into ~/.local/bin. The entry here
    // carried only the docs link, so choosing Kiro told the user to go and
    // read a web page instead of giving them the one line that works.
    command: 'curl -fsSL https://cli.kiro.dev/install | bash',
    docs: 'https://kiro.dev/docs/getting-started/installation/',
    source: 'https://kiro.dev/cli/ and cli.kiro.dev/install (verified: HTTP 200, a real install script)',
  },
  antigravity: {
    // A native Go binary -- no Node, no npm -- which the script puts at
    // ~/.local/bin/agy. That matches what is on this machine exactly, path
    // and all, which is the corroboration for taking this from its docs.
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docs: 'https://antigravity.google/docs/cli/install/',
    source: 'https://antigravity.google/docs/cli/install/ (verified: HTTP 200, a real install script)',
  },
};

/** The message shown when a harness has no npm package to install. */
export function installInstructions(displayName: string, command: string, binary: string): string {
  const hint = HARNESS_INSTALL_HINTS[command];
  const retry = `Then retry /${command}.`;
  if (!hint) {
    return `${displayName} does not publish an npm package ClikCode can install automatically. `
      + `Install its official CLI yourself (it must put a \`${binary}\` binary on PATH). ${retry}`;
  }
  if (!hint.command) {
    return `${displayName} does not install through npm. Its own instructions are at ${hint.docs} `
      + `(it must put a \`${binary}\` binary on PATH). ${retry}`;
  }
  return `${displayName} does not install through npm. Run this yourself — ClikCode will not run an `
    + `installer for you:\n\n    ${hint.command}\n\nFrom ${hint.source ?? hint.docs}. ${retry}`;
}
