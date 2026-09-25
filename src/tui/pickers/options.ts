/** Choosing among a harness's own declared options. */

import chalk from 'chalk';
import { vendorFacingOptions } from '../../harness/options.js';
import { discoverHermesChoices } from '../../harness/accounts/hermes-discovery.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { setSessionHarnessOption } from '../../session/options.js';
import { lastPickerExit } from '../option-picker.js';
import { chooseOption } from './choose.js';

export async function interactiveHarnessOptionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  // Back to the list after each change, so setting two options is one visit.
  for (;;) {
    if (!await harnessOptionPickerOnce(rl, id) || lastPickerExit === 'escape') return;
  }
}

/** One pass of the list; false when the user left it. */
async function harnessOptionPickerOnce(rl: HarnessPrompter, id: string): Promise<boolean> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const discovered = harness.command === 'hermes' ? await discoverHermesChoices(harness, account).catch(() => undefined) : undefined;
  const options = manifest.options.map((item) => {
    if (!discovered) return item;
    if (item.id === 'toolsets' && discovered.toolsets.length) return { ...item, values: discovered.toolsets };
    return item;
  });
  // Only what no ClikCode command already owns. /model, /permissions, /effort,
  // /cwd and /add-dir were each listed here as a raw vendor row as well, so the
  // same setting had two interfaces that could disagree.
  const current = (item: { id: string }): unknown => session.harnessOptions?.[item.id];
  const save = async (optionId: string, raw: string): Promise<void> => {
    const fresh = await readState();
    const target = fresh.sessions.find((item) => item.id === id);
    if (!target) return;
    // `default` (or `-` typed) clears the option: the harness's own default
    // applies, and nothing is sent.
    if (raw === 'default' || raw === '-') {
      const { [optionId]: _cleared, ...rest } = target.harnessOptions ?? {};
      target.harnessOptions = rest;
    } else setSessionHarnessOption(target, harness, optionId, raw);
    target.updatedAt = new Date().toISOString();
    await writeState(fresh);
  };
  // Few values: switched right in this list, the current one marked -- the
  // same rule as the settings menu (settings.ts). A boolean is On/Off. The
  // exception is one marked dangerous, which stays a row of its own so that
  // turning it on still goes through a confirmation rather than one keypress.
  const inlineFor = (item: (typeof manifest.options)[number]) => {
    if (item.dangerous) return {};
    const values = item.kind === 'boolean' ? ['on', 'off'] : item.values ?? [];
    if (values.length < 2 || values.length > 4) return {};
    const now = current(item);
    // Unset is "Default", not the first value: the first value is not what
    // runs when nothing is set, the harness's own default is.
    const currentValue = item.kind === 'boolean' ? (now === true ? 'on' : 'off') : now === undefined ? 'default' : String(now);
    return {
      inline: {
        choices: [
          ...(item.kind === 'boolean' ? [] : [{ label: 'Default', value: 'default' }]),
          ...values.map((value) => ({ label: value[0]!.toUpperCase() + value.slice(1), value })),
        ],
        current: currentValue,
        apply: (value: string) => save(item.id, value),
      },
    };
  };
  const option = await chooseOption(rl, `${harness.displayName} options`, vendorFacingOptions(options, harness).map((item) => ({
    label: item.label,
    detail: [
      `· ${item.description}`,
      ...(item.kind === 'boolean' ? [current(item) === true ? 'on' : 'off']
        : current(item) !== undefined ? [chalk.cyan(Array.isArray(current(item)) ? (current(item) as unknown[]).join(', ') : String(current(item)))] : []),
      ...(item.dangerous ? [chalk.yellow('dangerous')] : []),
    ].join(' · '),
    value: item,
    ...inlineFor(item),
  })));
  if (!option) return false;
  let raw: string | undefined;
  if (option.kind === 'boolean') {
    // Reached only for a dangerous switch (the rest flip in the list): off
    // goes straight through, on is confirmed.
    const turningOn = current(option) !== true;
    raw = turningOn
      ? await chooseOption(rl, `Turn on ${option.label}?`, [
        // Cancel first, as in every confirmation.
        { label: 'Cancel', value: '' }, { label: 'Turn on', detail: `· ${chalk.yellow('dangerous')}`, value: 'on' },
      ])
      : 'off';
  } else if (option.values?.length) {
    raw = await chooseOption(rl, option.label, [
      { label: 'Default', detail: `· ${harness.displayName} decides${current(option) === undefined ? ' · current' : ''}`, value: 'default' },
      ...option.values.map((entry) => ({ label: entry, detail: current(option) === entry ? '· current' : undefined, value: entry })),
    ]);
  } else {
    const list = option.kind === 'string-list' || option.kind === 'path-list';
    raw = (await rl.question(`${option.label}${list ? ' (comma-separated)' : ''}${current(option) !== undefined ? ' · - clears' : ''} › `)).trim();
  }
  if (raw === undefined || raw === '') return true;
  await save(option.id, raw);
  return true;
}
