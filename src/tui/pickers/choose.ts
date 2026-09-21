/** One arrow-key list, rendered by whichever prompter is on screen. Every
 * picker in this folder ends by calling the same command a typed slash line
 * would have, so a selection and a typed setting cannot drift apart. */

import { stdout as output } from 'node:process';
import chalk from 'chalk';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { emitHarnessOutput } from '../../harness/output.js';

export async function chooseOption<T>(
  rl: HarnessPrompter,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: {
    onBack?: () => void;
    onEscape?: () => void;
    refreshedOptions?: () => readonly PickerOption<T>[];
    refresh?: Promise<unknown>;
  },
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

/** A brand-new conversation root. How you want to work (provider, account,
 * model, effort, permissions, workspace) carries over; what you were talking
 * about does not. Crucially it takes a fresh conversationId and no parent, so
 * it lists as its own row in /resume instead of merging into the conversation
 * it was started from, and it carries no inherited name. */
/** Which account a conversation on this provider should use.
 *
 * The rule, in one place because it was previously decided in two: keep the
 * one it already has if that still fits, otherwise the account most recently
 * used on this provider, otherwise the first ready one. Null only when the
 * provider has no ready account at all.
 *
 * Both callers used to give up and store null as soon as a provider had more
 * than one account -- on the reasoning that the user should choose -- but
 * nothing asked them to, so the next turn failed with "no account selected"
 * on exactly the setups where an account was most obviously available. */
