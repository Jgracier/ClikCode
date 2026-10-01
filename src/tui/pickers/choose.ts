/** One arrow-key list, rendered by whichever prompter is on screen. Every
 * picker in this folder ends by calling the same command a typed slash line
 * would have, so a selection and a typed setting cannot drift apart. */

import { stdout as output } from 'node:process';
import chalk from 'chalk';
import type { HarnessPrompter, PickerOption, PickerSettings } from '../../harness/prompter.js';
import { emitHarnessOutput } from '../../harness/output.js';

export async function chooseOption<T>(
  rl: HarnessPrompter,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: PickerSettings<T>,
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  if (rl.select) return rl.select(title, options, onAction, settings);
  output.write(`\n${chalk.bold(title)}\n`);
  options.forEach((option, index) => {
    output.write(`  ${chalk.cyan(String(index + 1).padStart(2))}  ${option.label}${option.detail ? ` ${chalk.dim(option.detail)}` : ''}\n`);
  });
  output.write(`  ${chalk.dim('0   Cancel')}\n\n`);
  const answer = (await rl.question(chalk.bold('Choose › '))).trim();
  if (!answer || answer === '0') return undefined;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    emitHarnessOutput({ panel: 'error', message: `Choose a number from 1 to ${options.length}.` });
    return undefined;
  }
  return options[index].value;
}
