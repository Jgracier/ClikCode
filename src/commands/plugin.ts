/**
 * `clikcode plugin` -- the plugins the user installed for Claude Code, as
 * ClikCode's own agent uses them (agent/plugins.ts): list, enable, disable.
 * That choice is ClikCode's, written to its own state, never to ~/.claude.
 */
import chalk from 'chalk';
import { stdout as output } from 'node:process';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitResult } from '../cli/structured-output.js';
import { listPlugins, setPluginEnabled, type PluginRoots } from '../agent/plugins.js';
import { stateDirectory } from '../session/store/paths.js';

function roots(): PluginRoots {
  return { stateDir: stateDirectory() };
}

/** A failure is a message and exit code 1, not a stack trace. */
async function reported(action: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonDefaultMode()) emitResult({ plugin: action, error: message });
    else output.write(`\n${chalk.red('✗')} ${message}\n\n`);
    process.exitCode = 1;
  }
}

export function pluginList(): Promise<void> {
  return reported('list', async () => {
    const plugins = listPlugins(roots());
    if (isJsonDefaultMode()) return emitResult({ plugin: 'list', plugins });
    output.write(`\n${chalk.bold('Plugins')}\n`);
    for (const plugin of plugins) {
      const state = plugin.enabled ? chalk.green('enabled ') : chalk.dim('disabled');
      output.write(`  ${state} ${chalk.bold(plugin.id)}${plugin.version ? chalk.dim(` ${plugin.version}`) : ''}\n`);
      if (plugin.description) output.write(`           ${chalk.dim(plugin.description.slice(0, 100))}\n`);
    }
    if (!plugins.length) output.write(`  ${chalk.dim('none -- install one in Claude Code (/plugin)')}\n`);
    output.write('\n');
  });
}

export function pluginSetEnabled(name: string, enabled: boolean): Promise<void> {
  return reported(enabled ? 'enable' : 'disable', async () => {
    const plugin = await setPluginEnabled(roots(), name, enabled);
    if (isJsonDefaultMode()) return emitResult({ plugin: enabled ? 'enable' : 'disable', id: plugin.id, enabled });
    const note = chalk.dim(' in ClikCode (Claude Code\'s own setting is unchanged)');
    output.write(`\n${chalk.green('✓')} ${chalk.bold(plugin.id)} ${enabled ? 'enabled' : 'disabled'}${note}.\n\n`);
  });
}
