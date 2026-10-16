import { computerEnabled, setComputerEnabled } from '../agent/computer/settings.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { closeComputerBrowser } from '../agent/computer/browser.js';

export async function computerStatus(): Promise<void> {
  const enabled = await computerEnabled(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on for ClikCode’s own agent. Ask it to use the browser or desktop.\n'
    : 'Computer use is off. Run `clikcode computer on` once to make it available.\n');
}

export async function computerSetEnabled(enabled: boolean): Promise<void> {
  await setComputerEnabled(stateDirectory(), enabled);
  if (!enabled) await closeComputerBrowser(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The next ClikCode agent turn can use the browser and desktop. You will approve access when it first asks.\n'
    : 'Computer use is off for new ClikCode agent turns.\n');
}
