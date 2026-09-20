/** How each shared option id relates to ClikCode's own controls.
 *
 * A vendor CLI publishes its own flags; several vendors publish the same idea
 * under different names (`--cd`, `--dir`, `-C`, `--cwd`, `--workspace`, `--in`
 * are one concept) and several publish the same name for ideas that are only
 * superficially alike. Normalizing means deciding, once and in writing, which
 * of the three each shared id is:
 *
 *   common  — a ClikCode command already owns it. The raw vendor row must not
 *             be listed as well, or the same setting appears twice with two
 *             different interfaces, which is what was happening to fifty-six
 *             rows across the catalog.
 *   shared  — the same id and the same meaning everywhere, with no dedicated
 *             command. One row, one name, already uniform; nothing to fold.
 *   vendor  — the id coincides but the meaning or the value space does not.
 *             Promoting it would flatten a real difference.
 *
 * Every option id published by two or more harnesses appears here; a test
 * fails if one does not, so a new harness cannot quietly widen the surface.
 */
export type OptionNormalization =
  | { kind: 'common'; control: string; note: string }
  | { kind: 'shared'; note: string }
  | { kind: 'vendor'; note: string };

const common = (control: string, note: string): OptionNormalization => ({ kind: 'common', control, note });
const shared = (note: string): OptionNormalization => ({ kind: 'shared', note });
const vendor = (note: string): OptionNormalization => ({ kind: 'vendor', note });

export const OPTION_NORMALIZATION: Readonly<Record<string, OptionNormalization>> = {
  // --- owned by a ClikCode command -----------------------------------------
  model: common('/model', 'nineteen harnesses, six flag spellings, one selector.'),
  permissions: common('/permissions', 'mapped to ask/bypass/auto per harness by permissionArgv.'),
  effort: common('/effort', 'passed through to whatever the vendor calls its reasoning level.'),
  workspace: common('/cwd', '--cd, --dir, -C, --cwd, --workspace and --in are one concept.'),
  'add-dir': common('/add-dir', 'additional roots the agent may reach.'),
  'include-directories': common('/add-dir', 'Gemini and Qwen spell --add-dir this way; same concept, same control.'),

  // --- already uniform, no dedicated command needed -------------------------
  worktree: shared('--worktree on all seven, same meaning: run in an isolated managed worktree.'),
  'safe-mode': shared('--safe-mode on all four: disable customizations, plugins and MCP.'),
  ephemeral: shared('--ephemeral or --no-session: do not persist the native session.'),
  plan: shared('--plan on all three: start in read-only planning mode.'),
  sandbox: shared('restrict shell execution; the mechanism is the vendor\'s, the switch is not.'),
  trust: shared('skip the workspace trust prompt.'),
  tools: shared('choose the built-in tools available to the session.'),
  'allowed-tools': shared('tool patterns allowed without prompting.'),
  'mcp-config': shared('MCP configuration files or inline JSON.'),
  'plugin-dir': shared('plugin folders or archives loaded for the session.'),
  'disable-skills': shared('disable skill slash commands.'),
  'ignore-user-config': shared('do not load the user-level config file.'),
  'ignore-rules': shared('do not load user or project rules.'),
  title: shared('title assigned to a new native session.'),
  pure: shared('run without external plugins.'),
  'thinking-output': shared('include provider thinking blocks in event output.'),
  'fork-native-session': shared('fork before continuing the selected session.'),
  share: shared('publish the native session through the vendor.'),
  'max-turns': shared('maximum autonomous turns without user input.'),
  'data-dir': shared('isolated vendor state directory.'),

  // --- the id coincides; the meaning does not --------------------------------
  provider: vendor('an inference provider INSIDE a harness (Goose, Pi, Cline, Hermes), not ClikCode\'s provider. Promoting it would collide with /provider and mean something else.'),
  agent: vendor('every vendor has "agents" and none of them are the same thing; the value space is vendor-bound even though the flag name is not.'),
  mode: vendor('Antigravity means edit-accepting versus planning; Cursor means plan versus question. Shared name, different enums.'),
};

/** The command that owns this option, when one does. */
export function commonControlFor(id: string): string | undefined {
  const entry = OPTION_NORMALIZATION[id];
  return entry?.kind === 'common' ? entry.control : undefined;
}

/** Options to show as vendor rows: everything a ClikCode command does not
 * already own. Listing the others here too is how one setting ended up with
 * two interfaces. */
export function vendorFacingOptions<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter((option) => !commonControlFor(option.id));
}
