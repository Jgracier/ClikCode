/** Choosing among a harness's own declared options. */

import chalk from 'chalk';
import { vendorFacingOptions } from '../../harness/options.js';
import type { HarnessPrompter } from '../../harness/types.js';
import { localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { setSessionHarnessOption } from '../../session/options.js';
import { chooseOption } from './choose.js';

export async function interactiveHarnessOptionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  // Only what no ClikCode command already owns. /model, /permissions, /effort,
  // /cwd and /add-dir were each listed here as a raw vendor row as well, so the
  // same setting had two interfaces that could disagree.
  const option = await chooseOption(rl, `${harness.displayName} options`, vendorFacingOptions(manifest.options).map((item) => ({
    label: item.label,
    detail: `· ${item.description}${item.dangerous ? ` · ${chalk.yellow('dangerous')}` : ''}`,
    value: item,
  })));
  if (!option) return;
  let raw: string | undefined;
  if (option.kind === 'boolean') {
    raw = await chooseOption(rl, option.label, [
      { label: 'On', value: 'on' }, { label: 'Off', value: 'off' },
    ]);
  } else if (option.values?.length) {
    raw = await chooseOption(rl, option.label, option.values.map((entry) => ({ label: entry, value: entry })));
  } else {
    raw = (await rl.question(`${option.label} › `)).trim();
  }
  if (raw === undefined || raw === '') return;
  const fresh = await readState();
  const target = fresh.sessions.find((item) => item.id === id);
  if (!target) return;
  setSessionHarnessOption(target, harness, option.id, raw);
  target.updatedAt = new Date().toISOString();
  await writeState(fresh);
}
