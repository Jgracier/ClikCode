/**
 * `clikcode plugin` -- plugins in Claude Code's format for ClikCode's own
 * agent (agent/plugins.ts): add, list, remove, enable, disable, and the
 * marketplaces `name@marketplace` is looked up in.
 *
 * Plugins the user installed for Claude Code are listed too, and can be
 * enabled or disabled here; that choice is ClikCode's, written to its own
 * state, never to ~/.claude.
 */
import chalk from 'chalk';
import { stdout as output } from 'node:process';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitResult } from '../cli/structured-output.js';
import { listPlugins, type PluginRoots } from '../agent/plugins.js';
import {
  addMarketplace, addPlugin, listMarketplaces, removeMarketplace, removePlugin, setPluginEnabled,
} from '../agent/plugin-install.js';
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

export function pluginAdd(spec: string): Promise<void> {
  return reported('add', async () => {
    const { id, record } = await addPlugin(roots(), spec);
    if (isJsonDefaultMode()) return emitResult({ plugin: 'add', id, ...record });
    output.write(`\n${chalk.green('✓')} ${chalk.bold(id)}${record.version ? chalk.dim(` ${record.version}`) : ''} installed and enabled for ClikCode's own agent.\n\n`);
  });
}

export function pluginList(): Promise<void> {
  return reported('list', async () => {
    const plugins = listPlugins(roots());
    if (isJsonDefaultMode()) return emitResult({ plugin: 'list', plugins });
    output.write(`\n${chalk.bold('Plugins')}\n`);
    for (const plugin of plugins) {
      const state = plugin.enabled ? chalk.green('enabled ') : chalk.dim('disabled');
      const origin = plugin.origin === 'claude' ? chalk.dim(' (from Claude Code)') : '';
      output.write(`  ${state} ${chalk.bold(plugin.id)}${plugin.version ? chalk.dim(` ${plugin.version}`) : ''}${origin}\n`);
      if (plugin.description) output.write(`           ${chalk.dim(plugin.description.slice(0, 100))}\n`);
    }
    if (!plugins.length) output.write(`  ${chalk.dim('none -- add one with `plugin add <path | git url | name@marketplace>`')}\n`);
    output.write('\n');
  });
}

export function pluginRemove(name: string): Promise<void> {
  return reported('remove', async () => {
    const plugin = await removePlugin(roots(), name);
    if (isJsonDefaultMode()) return emitResult({ plugin: 'remove', id: plugin.id });
    output.write(`\n${chalk.green('✓')} ${chalk.bold(plugin.id)} removed.\n\n`);
  });
}

export function pluginSetEnabled(name: string, enabled: boolean): Promise<void> {
  return reported(enabled ? 'enable' : 'disable', async () => {
    const plugin = await setPluginEnabled(roots(), name, enabled);
    if (isJsonDefaultMode()) return emitResult({ plugin: enabled ? 'enable' : 'disable', id: plugin.id, enabled });
    const note = plugin.origin === 'claude' ? chalk.dim(' in ClikCode (Claude Code\'s own setting is unchanged)') : '';
    output.write(`\n${chalk.green('✓')} ${chalk.bold(plugin.id)} ${enabled ? 'enabled' : 'disabled'}${note}.\n\n`);
  });
}

export function pluginMarketplaceAdd(spec: string): Promise<void> {
  return reported('marketplace add', async () => {
    const record = await addMarketplace(roots(), spec);
    if (isJsonDefaultMode()) return emitResult({ plugin: 'marketplace add', ...record });
    output.write(`\n${chalk.green('✓')} Marketplace ${chalk.bold(record.name)} added. Install from it with \`plugin add <plugin>@${record.name}\`.\n\n`);
  });
}

export function pluginMarketplaceList(): Promise<void> {
  return reported('marketplace list', async () => {
    const marketplaces = listMarketplaces(roots());
    if (isJsonDefaultMode()) return emitResult({ plugin: 'marketplace list', marketplaces });
    output.write(`\n${chalk.bold('Plugin marketplaces')}\n`);
    for (const item of marketplaces) output.write(`  ${chalk.bold(item.name.padEnd(28))}${chalk.dim(item.path)}${item.origin === 'claude' ? chalk.dim(' (from Claude Code)') : ''}\n`);
    if (!marketplaces.length) output.write(`  ${chalk.dim('none -- add one with `plugin marketplace add <path | git url>`')}\n`);
    output.write('\n');
  });
}

export function pluginMarketplaceRemove(name: string): Promise<void> {
  return reported('marketplace remove', async () => {
    if (!await removeMarketplace(roots(), name)) throw new Error(`No marketplace named ${name} was added in ClikCode`);
    if (isJsonDefaultMode()) return emitResult({ plugin: 'marketplace remove', name });
    output.write(`\n${chalk.green('✓')} Marketplace ${chalk.bold(name)} removed. Plugins installed from it stay installed.\n\n`);
  });
}
