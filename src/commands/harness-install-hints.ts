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

export interface HarnessInstallHint {
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
  goose: { docs: 'https://github.com/block/goose' },
  antigravity: { docs: 'https://antigravity.google' },
  kiro: { docs: 'https://kiro.dev' },
  hermes: { docs: 'https://github.com/NousResearch' },
  openhands: { docs: 'https://github.com/All-Hands-AI/OpenHands' },
  vibe: { docs: 'https://github.com/vibe-acp' },
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
