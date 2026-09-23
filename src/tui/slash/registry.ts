/** The ONE slash-command registry for ClikCode.
 *
 * The palette, the human /help panel, the JSON `controls`, and both dispatchers
 * (the interactive loop and the headless `aiSessionCommand`) are all generated
 * from SLASH_COMMANDS, so they cannot drift apart. Pure: no I/O, no state, no
 * harness names -- availability is decided from catalog fields only. */
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';

type SlashGroup =
  | 'Common' | 'Conversation' | 'Workspace' | 'Provider' | 'Settings' | 'Sessions' | 'Info' | 'Tools' | 'Custom' | 'Switch harness';

const SLASH_GROUP_ORDER: readonly SlashGroup[] = [
  'Common', 'Conversation', 'Workspace', 'Provider', 'Settings', 'Sessions', 'Info', 'Tools', 'Custom', 'Switch harness',
];

/** The handful of commands worth reaching without scrolling, in the order
 * they are reached for: pick a provider, pick an account on it, resume a
 * conversation, change the model. Then the two that get used mid-conversation
 * more than anything else -- starting over, and changing what needs approval.
 *
 * Palette only. `/help` keeps its own grouping, because a reference reads
 * better by topic than by frequency. The palette draws a header whenever the
 * group changes, so these carry one shared group rather than their real one:
 * otherwise the top of the list flips between four headers and prints
 * "Settings" twice. */
export const SLASH_PALETTE_PINNED: readonly string[] = [
  'provider', 'account', 'resume', 'model', 'new', 'permissions',
];

/** Every handler a dispatcher must implement. `as const` so both handler
 * tables are typed `Record<SlashHandlerKey, …>` and a missing or extra handler
 * is a compile error as well as a parity-test failure. */
export const SLASH_HANDLER_KEYS = [
  'help', 'status', 'new', 'redraw', 'exit', 'compact', 'context', 'cost', 'export', 'history', 'copy', 'select', 'undo',
  'native', 'review', 'init', 'memory', 'diff', 'cwd', 'add-dir', 'mention', 'attachments',
  'provider', 'account', 'accounts', 'login', 'logout', 'gateway',
  'model', 'models', 'effort', 'permissions', 'options', 'capabilities', 'settings',
  'sessions', 'resume', 'rename', 'fork', 'archive', 'delete',
  'usage', 'doctor',
] as const;
export type SlashHandlerKey = typeof SLASH_HANDLER_KEYS[number];

interface SlashAvailability {
  available: boolean;
  reason?: string;
  /** What is MISSING, when supplying it would make the command available. A
   * caller that can ask for it should do that instead of refusing: the user
   * typed `/model`, so wanting to choose a model is not in doubt, and
   * "choose a provider first" is a smaller answer than the question. Absent
   * where the answer is a real limit -- a vendor with no model selector, a
   * gateway route whose policy is not the user's to set. */
  needs?: 'provider';
}

interface SlashCommandEntry {
  /** Without the leading slash. */
  name: string;
  aliases: readonly string[];
  argHint?: string;
  description: string;
  group: SlashGroup;
  availability(session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined): SlashAvailability;
  handlerKey: SlashHandlerKey;
  /** `apply` means the ARGUMENT form of this command is a pure state write
   * that can run while a turn is streaming: no picker, no panel, nothing on
   * screen but the status line it is already reflected in. Those apply the
   * moment they are typed. Everything else waits for the turn to end, which
   * is the next moment it could run without taking the screen. */
  duringTurn?: 'apply';
}

const always = (): SlashAvailability => ({ available: true });
const GATEWAY_MANAGED = 'Gateway selects this by platform policy; it applies only to local harnesses.';
const localOnly = (session: HarnessSession | undefined): SlashAvailability =>
  session?.route === 'gateway' ? { available: false, reason: GATEWAY_MANAGED } : { available: true };
const needsHarness = (what: string) => (session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined): SlashAvailability => {
  const local = localOnly(session);
  if (!local.available) return local;
  return harness ? { available: true } : { available: false, reason: `Choose a provider before ${what}.`, needs: 'provider' };
};
/** Reads this machine's repository, which both routes can now do: the gateway
 * route runs ClikCode's own agent loop locally and asks the gateway only for
 * the model step, so its tools touch the same files a local harness does. */
const needsRepoAccess = (_name: string) => (): SlashAvailability => ({ available: true });

/** Governs what the agent may do to THIS machine, so it applies on both
 * routes. The gateway picks the model; it does not get to pick how much of
 * the user's filesystem an agent may touch without asking. */
const bothRoutes = (what: string) => (
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined,
): SlashAvailability => (session?.route === 'gateway'
  ? { available: true }
  : harness ? { available: true } : { available: false, reason: `Choose a provider before ${what}.`, needs: 'provider' });

function entry(
  name: string, group: SlashGroup, description: string,
  extra: Partial<Pick<SlashCommandEntry, 'aliases' | 'argHint' | 'availability' | 'handlerKey' | 'duringTurn'>> = {},
): SlashCommandEntry {
  return {
    name, group, description, aliases: extra.aliases ?? [], availability: extra.availability ?? always,
    handlerKey: extra.handlerKey ?? name as SlashHandlerKey, ...(extra.argHint ? { argHint: extra.argHint } : {}),
    ...(extra.duringTurn ? { duringTurn: extra.duringTurn } : {}),
  };
}

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  entry('new', 'Conversation', 'start a fresh conversation (the current one stays resumable)', { aliases: ['clear', 'reset'], argHint: '[first message]' }),
  entry('compact', 'Conversation', 'summarize the conversation and continue in a fresh native session', { argHint: '[focus]', availability: localOnly }),
  entry('history', 'Conversation', 'show this conversation'),
  entry('copy', 'Conversation', 'copy the last answer'),
  entry('export', 'Conversation', 'write the transcript as markdown', { argHint: '[path]' }),
  entry('undo', 'Conversation', 'revert the last turn (only where the vendor exposes it)'),
  entry('native', 'Conversation', 'send text to the harness verbatim (also: //text)', { argHint: '<text>', availability: needsHarness('sending native commands') }),
  entry('select', 'Conversation', 'release the mouse so you can select and copy text'),
  entry('redraw', 'Conversation', 'repaint the screen'),
  entry('exit', 'Conversation', 'save and leave', { aliases: ['quit'] }),

  entry('review', 'Workspace', 'ask the provider to review uncommitted changes', { argHint: '[focus]', availability: needsRepoAccess('review') }),
  entry('init', 'Workspace', "create or improve the harness's agent instructions file", { availability: needsRepoAccess('init') }),
  entry('memory', 'Workspace', "show the harness's memory file; `edit` opens $EDITOR", { argHint: '[edit]' }),
  entry('diff', 'Workspace', 'changes against HEAD, staged included, plus untracked files'),
  entry('cwd', 'Workspace', 'show or change the working directory', { argHint: '[dir]' }),
  entry('add-dir', 'Workspace', 'give the harness another writable directory', { argHint: '<dir>', availability: bothRoutes('adding directories') }),
  entry('mention', 'Workspace', 'attach a file to the next request', { argHint: '[path]' }),
  entry('attachments', 'Workspace', 'queued files; `clear` empties them', { argHint: '[clear]' }),

  entry('provider', 'Provider', 'choose a provider', { aliases: ['switch', 'engine'] }),
  entry('account', 'Provider', 'switch accounts', { argHint: '[label]', duringTurn: 'apply' }),
  entry('accounts', 'Provider', 'list and manage accounts', { argHint: '[use|login|add|remove|failover …]' }),
  entry('login', 'Provider', 'sign in to the current provider', { availability: needsHarness('signing in') }),
  entry('logout', 'Provider', 'sign the current account out', { availability: needsHarness('signing out') }),
  entry('gateway', 'Provider', 'route this conversation through Gateway'),

  entry('model', 'Settings', 'choose or set a model', {
    argHint: '[name]',
    duringTurn: 'apply',
    availability: (session, harness) => {
      const base = needsHarness('choosing a model')(session, harness);
      if (!base.available) return base;
      return harness!.modelArgvPrefix ? { available: true } : { available: false, reason: `${harness!.displayName} does not publish a model selector.` };
    },
  }),
  entry('models', 'Settings', 'list models configured on local accounts'),
  entry('effort', 'Settings', 'reasoning level', { argHint: '[level]', availability: needsHarness('setting effort'), duringTurn: 'apply' }),
  entry('permissions', 'Settings', 'approval behavior', { argHint: '[ask|bypass|auto]', availability: bothRoutes('setting permissions'), duringTurn: 'apply' }),
  entry('options', 'Settings', 'provider-specific modes and controls', { availability: needsHarness('setting options') }),
  entry('capabilities', 'Settings', 'what the selected provider supports'),
  entry('settings', 'Settings', 'configure this workspace', { argHint: '[route|account|model|effort|permissions|option|global|provider …]' }),

  entry('sessions', 'Sessions', 'manage conversations', { argHint: '[list|show|open|close <id>]' }),
  entry('resume', 'Sessions', 'resume another conversation'),
  entry('rename', 'Sessions', 'name this conversation', { argHint: '[name]' }),
  entry('fork', 'Sessions', 'branch this conversation', { argHint: '[name]' }),
  entry('archive', 'Sessions', 'archive this conversation'),
  entry('delete', 'Sessions', 'delete this conversation', { argHint: '[confirm]' }),

  entry('status', 'Info', 'current configuration'),
  entry('context', 'Info', 'context window and token usage reported by the harness'),
  entry('cost', 'Info', 'tokens and cost for this conversation'),
  entry('usage', 'Info', 'token usage for this account'),
  entry('doctor', 'Info', 'check installed harnesses and accounts'),
  entry('help', 'Info', 'all commands', { aliases: ['?'] }),
];

const BY_NAME: ReadonlyMap<string, SlashCommandEntry> = new Map(
  SLASH_COMMANDS.flatMap((item) => [[item.name, item] as const, ...item.aliases.map((alias) => [alias, item] as const)]),
);

export function resolveSlashCommand(head: string): SlashCommandEntry | undefined {
  return BY_NAME.get(head.toLowerCase());
}

interface ParsedSlashInput { head: string; args: string; words: string[] }

/** `head + args`, uniformly: `/model gpt-5` and `/model` reach the same handler. */
export function parseSlashInput(line: string): ParsedSlashInput | undefined {
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match) return undefined;
  const args = (match[2] ?? '').trim();
  return { head: match[1]!.toLowerCase(), args, words: args ? args.split(/\s+/) : [] };
}

interface SlashPaletteEntry { label: string; value: string; detail: string; argHint?: string; group: SlashGroup }
export interface SlashExtras {
  /** Vendor managers the harness declares (mcp, skills, …). */
  managers?: ReadonlyArray<{ name: string; label: string }>;
  /** Commands the ACP agent advertised for this session. */
  native?: ReadonlyArray<{ name: string; description?: string; hint?: string }>;
  custom?: ReadonlyArray<{ name: string; description?: string; argumentHint?: string }>;
  harnesses?: ReadonlyArray<{ command: string; displayName: string }>;
}

/** Every listable row. Unavailable commands stay listed with their reason so
 * the user learns why, instead of a command silently disappearing. `vendor`
 * adds the surfaces the terminal harness itself owns: its manager commands and
 * whatever an ACP agent advertised. ClikCode's own `/<harness>` switch rows
 * are not vendor commands and always come last. */
function slashRows(
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined,
  extras: SlashExtras, vendor: boolean,
): SlashPaletteEntry[] {
  const rows: SlashPaletteEntry[] = SLASH_COMMANDS.map((item) => {
    const state = item.availability(session, harness);
    return {
      label: `/${item.name}`, value: `/${item.name}`, group: item.group,
      detail: state.available ? item.description : `unavailable · ${state.reason ?? item.description}`,
      ...(item.argHint ? { argHint: item.argHint } : {}),
    };
  });
  const taken = new Set(BY_NAME.keys());
  const push = (row: SlashPaletteEntry): void => {
    const name = row.value.slice(1).toLowerCase();
    if (taken.has(name)) return;
    taken.add(name);
    rows.push(row);
  };
  if (vendor) {
    for (const manager of extras.managers ?? []) push({ label: `/${manager.name}`, value: `/${manager.name}`, detail: manager.label, group: 'Tools' });
    for (const item of extras.native ?? []) {
      push({ label: `/${item.name}`, value: `/${item.name}`, detail: item.description ?? 'harness command', group: 'Tools', ...(item.hint ? { argHint: item.hint } : {}) });
    }
  }
  for (const item of extras.custom ?? []) {
    push({ label: `/${item.name}`, value: `/${item.name}`, detail: item.description ?? 'custom command', group: 'Custom', ...(item.argumentHint ? { argHint: item.argumentHint } : {}) });
  }
  for (const item of extras.harnesses ?? []) {
    push({ label: `/${item.command}`, value: `/${item.command}`, detail: `switch to ${item.displayName}`, argHint: '[request]', group: 'Switch harness' });
  }
  const rank = (row: SlashPaletteEntry): number => SLASH_GROUP_ORDER.indexOf(row.group);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}

/** Palette rows: ClikCode's OWN commands -- the registry, the user's custom
 * templates, and the `/<harness>` switch rows (ClikCode's own handoff
 * feature, merely named after each CLI). What the VENDOR owns stays out: its
 * manager surfaces (/mcp, /plugins, …) and the commands an ACP agent
 * advertises. A palette that mixes both reads as one flat namespace, so a
 * vendor-owned name looks like a ClikCode command and a ClikCode name
 * silently shadows the vendor's. Those still run when typed (routeSlashInput
 * is unchanged) and `/help` lists them. */
export function slashPalette(
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined, extras: SlashExtras = {},
): SlashPaletteEntry[] {
  // ClikCode's own commands only. The `/<harness>` switch rows are ClikCode's
  // feature, but there are two dozen of them and every one is named after a
  // terminal CLI, so the palette read as the terminal's own command list
  // pasted underneath ClikCode's. They still run when typed, and /help still
  // documents them as `/<harness> [request]`.
  const rows = slashRows(session, harness, extras, false).filter((row) => row.group !== 'Switch harness');
  // A pinned command that is unavailable on this route or harness was already
  // dropped above; pinning never resurrects one.
  const pinned = SLASH_PALETTE_PINNED
    .map((name) => rows.find((row) => row.value === `/${name}`))
    .filter((row): row is SlashPaletteEntry => row !== undefined)
    .map((row) => ({ ...row, group: 'Common' as const }));
  const pinnedValues = new Set(pinned.map((row) => row.value));
  return [...pinned, ...rows.filter((row) => !pinnedValues.has(row.value))];
}

/** `[usage, description]` rows per group, for the human /help panel. */
function slashHelpSections(
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined, extras: SlashExtras = {},
): Array<{ group: SlashGroup; rows: Array<[string, string]> }> {
  const sections = new Map<SlashGroup, Array<[string, string]>>();
  for (const row of slashRows(session, harness, extras, true)) {
    if (row.group === 'Switch harness') continue;
    const aliases = resolveSlashCommand(row.value.slice(1))?.aliases ?? [];
    sections.set(row.group, [...(sections.get(row.group) ?? []), [row.label, `${row.detail}${aliases.length ? ` (also /${aliases.join(', /')})` : ''}`]]);
  }
  const result = SLASH_GROUP_ORDER.filter((group) => sections.has(group)).map((group) => ({ group, rows: sections.get(group)! }));
  result.push({ group: 'Switch harness', rows: [
    ['/<harness>', 'hand off to another provider and optionally send a first request'],
    ['//<text>', 'send a slash command to the harness itself, verbatim'],
  ] });
  return result;
}

export function slashHelpText(
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined, extras: SlashExtras = {},
): string {
  return slashHelpSections(session, harness, extras).map(({ group, rows }) => {
    const width = Math.min(34, Math.max(...rows.map(([usage]) => usage.length)) + 2);
    return `${group}\n${rows.map(([usage, description]) => `  ${usage.padEnd(width)}${description}`).join('\n')}`;
  }).join('\n\n');
}

/** Machine-readable command list for `--json` consumers. */
export function slashControls(): Array<{ command: string; aliases: string[]; argHint?: string; description: string; group: SlashGroup }> {
  return [
    ...SLASH_COMMANDS.map((item) => ({
      command: `/${item.name}`, aliases: item.aliases.map((alias) => `/${alias}`), description: item.description, group: item.group,
      ...(item.argHint ? { argHint: item.argHint } : {}),
    })),
    { command: '/<harness>', aliases: [], argHint: '[request]', description: 'hand off to another provider and optionally send a first request', group: 'Switch harness' as const },
    { command: '//<text>', aliases: [], description: 'send a slash command to the harness itself, verbatim', group: 'Conversation' as const },
  ];
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!;
      previous[column] = Math.min(above + 1, previous[column - 1]! + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

export function suggestSlashCommand(head: string, candidates: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = name.startsWith(head) || head.startsWith(name) ? 1 : editDistance(head, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(head.length / 3)) ? best.name : undefined;
}

export interface SlashRouteContext {
  harness?: AiLocalHarnessDefinition;
  /** Catalog commands that can be switched to with `/<harness>`. */
  harnessCommands?: readonly string[];
  managerNames?: readonly string[];
  /** ACP `available_commands` captured for this session. */
  nativeCommands?: readonly string[];
  customCommands?: readonly string[];
  /** Whether the first whitespace-delimited token names an existing path. */
  pathExists?: (path: string) => boolean;
}

type SlashRoute =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'command'; entry: SlashCommandEntry; head: string; args: string; words: string[] }
  | { kind: 'harness'; command: string; args: string }
  | { kind: 'manager'; name: string; args: string }
  | { kind: 'custom'; name: string; args: string }
  /** Forwarded to the active harness verbatim, as the prompt. */
  | { kind: 'native'; prompt: string; why: 'explicit' | 'passthrough' | 'advertised' }
  | { kind: 'unknown'; head: string; suggestion?: string };

/** Decide what one submitted line means. Precedence:
 *   1. not a slash line, or an existing filesystem path  -> prompt
 *   2. `//text`                                           -> native, verbatim `/text`
 *   3. registry command (incl. `/native <text>`)          -> command
 *   4. vendor manager, custom command, `/<harness>`       -> their own routes
 *   5. advertised by the ACP agent, or the harness declares
 *      `nativeSlashPassthrough`                           -> native, verbatim
 *   6. otherwise unknown, with a did-you-mean suggestion. */
/** Whether this route can be applied to a session while a turn is streaming.
 * Only the argument form: without one, `/model` is a picker and a picker
 * needs the screen the answer is being written on. */
export function slashRouteAppliesDuringTurn(route: SlashRoute): boolean {
  return route.kind === 'command' && route.entry.duringTurn === 'apply' && route.args.trim().length > 0;
}

export function routeSlashInput(line: string, context: SlashRouteContext = {}): SlashRoute {
  const text = line.trim();
  if (!text.startsWith('/')) return { kind: 'prompt', prompt: text };
  if (text.startsWith('//')) {
    const literal = text.slice(1).trim();
    return literal.length > 1 ? { kind: 'native', prompt: literal, why: 'explicit' } : { kind: 'prompt', prompt: text };
  }
  const firstToken = text.split(/\s+/, 1)[0]!;
  // `/etc/hosts explain this` is a request about a file, not a command. A
  // single-segment token (`/model`) is only a path when nothing claims it.
  const looksNested = firstToken.indexOf('/', 1) > 0;
  if (looksNested && context.pathExists?.(firstToken)) return { kind: 'prompt', prompt: text };
  const parsed = parseSlashInput(text);
  if (!parsed) return { kind: 'prompt', prompt: text };
  const { head, args, words } = parsed;
  const entryMatch = resolveSlashCommand(head);
  if (entryMatch) return { kind: 'command', entry: entryMatch, head, args, words };
  if (context.managerNames?.includes(head)) return { kind: 'manager', name: head, args };
  if (context.customCommands?.includes(head)) return { kind: 'custom', name: head, args };
  if (context.harnessCommands?.includes(head)) return { kind: 'harness', command: head, args };
  if (context.nativeCommands?.includes(head)) return { kind: 'native', prompt: text, why: 'advertised' };
  if (!looksNested && context.pathExists?.(firstToken)) return { kind: 'prompt', prompt: text };
  if (context.harness?.nativeSlashPassthrough) return { kind: 'native', prompt: text, why: 'passthrough' };
  const suggestion = suggestSlashCommand(head, [
    ...BY_NAME.keys(), ...(context.managerNames ?? []), ...(context.customCommands ?? []), ...(context.harnessCommands ?? []),
  ]);
  return { kind: 'unknown', head, ...(suggestion ? { suggestion } : {}) };
}

export function unknownSlashMessage(route: { head: string; suggestion?: string }): string {
  return `unknown slash command: /${route.head}${route.suggestion ? ` — did you mean /${route.suggestion}?` : ''}. Use //${route.head} to send it to the harness verbatim.`;
}
