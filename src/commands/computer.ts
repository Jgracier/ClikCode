import { computerEnabled, setComputerEnabled } from '../agent/computer/settings.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { closeComputerBrowser } from '../agent/computer/browser.js';
import { lockCredentialVault } from '../agent/computer/credential-vault.js';

export async function computerStatus(): Promise<void> {
  const enabled = await computerEnabled(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off. Run `clikcode computer on` to make it available.\n');
}

export async function computerSetEnabled(enabled: boolean): Promise<void> {
  await setComputerEnabled(stateDirectory(), enabled);
  if (!enabled) { await closeComputerBrowser(stateDirectory()); lockCredentialVault(stateDirectory()); }
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off for new ClikCode agent turns.\n');
}
