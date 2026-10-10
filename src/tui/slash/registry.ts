/** The ONE slash-command registry for ClikCode.
 *
 * The palette, the human /help panel, the JSON `controls`, and both dispatchers
 * (the interactive loop and the headless `aiSessionCommand`) are all generated
 * from SLASH_COMMANDS, so they cannot drift apart. Pure: no I/O, no state, no
 * harness names -- availability is decided from catalog fields only. */
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';
import { AGENT_COMPACTS_ITSELF, isClikCodeAgent, isGatewayService } from '../../session/route.js';
import { harnessSupportsModelSelection } from '../../runtime/lazy-bridge.js';

type SlashGroup =
  | 'Common' | 'Conversation' | 'Workspace' | 'Provider' | 'Settings' | 'Sessions' | 'Info' | 'Tools' | 'Custom' | 'Switch harness';

const SLASH_GROUP_ORDER: readonly SlashGroup[] = [
  'Common', 'Conversation', 'Workspace', 'Provider', 'Settings', 'Sessions', 'Info', 'Tools', 'Custom', 'Switch harness',
];

/** The commands worth reaching without scrolling, always in this order:
 * resume a conversation, pick a provider, an account on it, then its model.
 * The terminal palette omits resume and new — the conversation board owns
 * them — so Common opens there as provider, account, model, and model is
 * the third row. Then the ones used mid-conversation most -- starting over,
 * changing what needs approval -- and the settings, sessions, status and
 * help screens. Fixed, not ranked by use: a list that reorders itself moves
 * the row the user's hand already knows.
 *
 * Palette only. `/help` keeps its own grouping, because a reference reads
 * better by topic than by frequency. The palette draws a header whenever the
 * group changes, so these carry one shared group rather than their real one:
 * otherwise the top of the list flips between four headers and prints
 * "Settings" twice. */
export const SLASH_PALETTE_PINNED: readonly string[] = [
  'resume', 'provider', 'account', 'model', 'new', 'permissions', 'settings', 'sessions', 'status', 'help',
];

/** Every handler a dispatcher must implement. `as const` so both handler
 * tables are typed `Record<SlashHandlerKey, …>` and a missing or extra handler
 * is a compile error as well as a parity-test failure. */
export const SLASH_HANDLER_KEYS = [
  'help', 'status', 'new', 'redraw', 'exit', 'compact', 'context', 'export', 'history', 'copy', 'select', 'undo', 'changes',
  'native', 'review', 'init', 'memory', 'diff', 'cwd', 'add-dir', 'mention',
  'provider', 'accounts', 'login', 'logout', 'gateway',
  'model', 'effort', 'fast', 'swarm', 'permissions', 'sandbox', 'send', 'options', 'capabilities', 'settings',
  'sessions', 'resume', 'search', 'rename', 'fork', 'redo', 'archive', 'delete',
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
const GATEWAY_MANAGED = 'ClikDeploy Gateway selects this by platform policy; it applies only to local harnesses.';
const CLIKCODE_LOCAL_AGENT = "ClikCode Local runs ClikCode's own agent; this applies only to vendor harnesses.";
const CLIKCODE_LOCAL_NO_EFFORT = 'ClikCode Local runs each model with its own default reasoning; llama.cpp publishes no effort control to set.';
/** Vendor-harness commands: neither route that runs ClikCode's own agent has
 * a harness for them to reach. The reason names why for each route. */
const localOnly = (session: HarnessSession | undefined): SlashAvailability => {
  if (!isClikCodeAgent(session)) return { available: true };
  return { available: false, reason: isGatewayService(session) ? GATEWAY_MANAGED : CLIKCODE_LOCAL_AGENT };
};
/** ClikCode's own agent compacts its context by itself; /compact is the
 * vendor-harness summary-and-branch path. */
const vendorCompaction = (session: HarnessSession | undefined): SlashAvailability => (isClikCodeAgent(session)
  ? { available: false, reason: AGENT_COMPACTS_ITSELF }
  : { available: true });
/** ClikCode's own agent's settings: a vendor harness runs its own commands. */
const agentOnly = (session: HarnessSession | undefined): SlashAvailability => (isClikCodeAgent(session)
  ? { available: true }
  : { available: false, reason: "The sandbox applies to ClikCode's own agent (ClikDeploy Gateway or ClikCode Local); a vendor harness sandboxes its own commands." });
const needsHarness = (what: string) => (session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined): SlashAvailability => {
  const local = localOnly(session);
  if (!local.available) return local;
  return harness ? { available: true } : { available: false, reason: `Choose a provider before ${what}.`, needs: 'provider' };
};

/** Governs what the agent may do to THIS machine, so it applies on both
 * routes. The gateway picks the model; it does not get to pick how much of
 * the user's filesystem an agent may touch without asking. */
const bothRoutes = (what: string) => (
  session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined,
): SlashAvailability => (isClikCodeAgent(session)
  ? { available: true }
  : harness ? { available: true } : { available: false, reason: `Choose a provider before ${what}.`, needs: 'provider' });

/** /undo reverses ClikCode's agent's own snapshots, or the edits a vendor
 * harness reports with their diffs. A plain-text CLI reports none: its
 * output is prose, so there is nothing for ClikCode to reverse. */
const undoAvailability = (session: HarnessSession | undefined, harness: AiLocalHarnessDefinition | undefined): SlashAvailability => {
  if (isClikCodeAgent(session) || harness?.transport !== 'text-cli') return { available: true };
  return {
    available: false,
    reason: `${harness.displayName} runs as a plain-text CLI: its output reports no file edits ClikCode could reverse, and it exposes no undo of its own to ClikCode. Use /diff to see what changed and git to revert it.`,
  };
};

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

/** Commands about the terminal itself -- its mouse, its screen, leaving it.
 * An editor client neither lists nor runs them. */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set(['select', 'redraw', 'exit']);

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  entry('new', 'Conversation', 'start a fresh conversation (the current one stays resumable)', { aliases: ['clear', 'reset'], argHint: '[first message]' }),
  entry('compact', 'Conversation', 'summarize the conversation and continue in a fresh native session', { argHint: '[focus]', availability: vendorCompaction }),
  entry('history', 'Conversation', 'show this conversation'),
  entry('copy', 'Conversation', 'copy the last answer'),
  entry('export', 'Conversation', 'write the transcript as markdown', { argHint: '[path]' }),
  entry('undo', 'Conversation', "revert the last turn's file edits, or the last N turns' (refuses files changed since)", { argHint: '[N]', availability: undoAvailability }),
  entry('changes', 'Conversation', "each recent turn's file edits; N shows that turn's diff", { argHint: '[N]', availability: undoAvailability }),
  entry('native', 'Conversation', 'send text to the harness verbatim (also: //text)', { argHint: '<text>', availability: needsHarness('sending native commands') }),
  entry('select', 'Conversation', "hand the mouse to the terminal's own selection (drag-to-copy works without it)"),
  entry('redraw', 'Conversation', 'repaint the screen'),
  entry('exit', 'Conversation', 'save and leave', { aliases: ['quit'] }),

  entry('review', 'Workspace', 'ask the provider to review uncommitted changes', { argHint: '[focus]' }),
  entry('init', 'Workspace', "create or improve the harness's agent instructions file"),
  entry('memory', 'Workspace', "show the harness's memory file; `edit` opens $EDITOR", { argHint: '[edit]' }),
  entry('diff', 'Workspace', 'changes against HEAD, staged included, plus untracked files'),
  entry('cwd', 'Workspace', 'show or change the working directory', { argHint: '[dir]' }),
  entry('add-dir', 'Workspace', 'give the harness another writable directory', { argHint: '<dir>', availability: bothRoutes('adding directories') }),
  entry('mention', 'Workspace', 'attach a file to the next request; alone, lists what is attached', { aliases: ['attachments'], argHint: '[path|clear]' }),

  entry('provider', 'Provider', 'choose a provider', { aliases: ['switch'] }),
  entry('account', 'Provider', 'switch, add or remove accounts', { aliases: ['accounts'], handlerKey: 'accounts', argHint: '[label|login|add|remove …]', duringTurn: 'apply' }),
  entry('login', 'Provider', 'sign in to the current provider', { availability: needsHarness('signing in') }),
  entry('logout', 'Provider', 'sign the current account out', { availability: needsHarness('signing out') }),
  entry('gateway', 'Provider', 'route this conversation through ClikDeploy Gateway'),

  entry('model', 'Settings', 'choose or set a model', {
    argHint: '[name]',
    duringTurn: 'apply',
    availability: (session, harness) => {
      // The Gateway publishes its own list; the user chooses from it.
      if (isGatewayService(session)) return { available: true };
      // ClikCode Local's models are its engine's catalog, not a harness's.
      if (session?.route === 'clikcode-local') return { available: true };
      const base = needsHarness('choosing a model')(session, harness);
      if (!base.available) return base;
      return harnessSupportsModelSelection(harness!) ? { available: true } : { available: false, reason: `${harness!.displayName} does not publish a model selector.` };
    },
  }),
  entry('effort', 'Settings', 'reasoning level', {
    argHint: '[level]', duringTurn: 'apply',
    availability: (session, harness) => (session?.route === 'clikcode-local'
      ? { available: false, reason: CLIKCODE_LOCAL_NO_EFFORT }
      // The Gateway takes a reasoning level with every step.
      : isGatewayService(session) ? { available: true }
        : needsHarness('setting effort')(session, harness)),
  }),
  entry('swarm', 'Settings', 'flip swarm on or off for this chat', {
    argHint: '[on|off]', duringTurn: 'apply', availability: always,
  }),
  entry('fast', 'Settings', 'serve from the fastest provider instead of the cheapest', {
    argHint: '[on|off]', duringTurn: 'apply',
    availability: (session) => (isGatewayService(session)
      ? { available: true }
      : { available: false, reason: 'Speed is a ClikDeploy Gateway choice: it picks among the providers of one model.' }),
  }),
  entry('permissions', 'Settings', 'approval behavior', { argHint: '[ask|bypass|auto]', availability: bothRoutes('setting permissions'), duringTurn: 'apply' }),
  entry('sandbox', 'Settings', "whether the agent's shell commands write only the workspace, temp and caches (on by default)", { argHint: '[on|off]', availability: agentOnly }),
  entry('send', 'Settings', 'messages typed mid-turn: steer into the turn, or queue for after it', { argHint: '[steer|queue]', duringTurn: 'apply' }),
  entry('options', 'Settings', 'provider-specific modes and controls', { availability: needsHarness('setting options') }),
  entry('capabilities', 'Settings', 'what the selected provider supports'),
  entry('settings', 'Settings', 'configure this workspace', { argHint: '[tools|model|effort|permissions|option|global|provider …]' }),

  entry('sessions', 'Sessions', 'manage conversations', { argHint: '[list|show|open|close <id>]' }),
  entry('resume', 'Sessions', 'resume another conversation'),
  entry('search', 'Sessions', 'open the conversation that mentions something most, at each mention', { argHint: '<words>' }),
  entry('rename', 'Sessions', 'name this conversation', { argHint: '[name]' }),
  entry('fork', 'Sessions', 'branch this conversation, or only through message N', { argHint: '[@N] [name]' }),
  entry('redo', 'Conversation', 'go back to before one of your prompts and send it again, edited or not; its edits and later ones are put back unless "keep"', { argHint: '[@N] [keep]' }),
  entry('archive', 'Sessions', 'archive this conversation'),
  entry('delete', 'Sessions', 'delete this conversation', { argHint: '[confirm]' }),

  entry('status', 'Info', 'current configuration'),
  entry('context', 'Info', 'context window and token usage reported by the harness'),
  entry('usage', 'Info', 'quota, tokens, and cost for this provider', { aliases: ['cost'], argHint: '[all]' }),
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
  /** Registry commands this surface does not offer: listed nowhere, and the
   * surface answers them itself when typed. */
  omit?: ReadonlySet<string>;
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
  const rows: SlashPaletteEntry[] = SLASH_COMMANDS.filter((item) => !extras.omit?.has(item.name)).map((item) => {
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
  // A pinned command this session cannot run stays in its own group, marked
  // unavailable; pinning never puts a row at the top that errors when chosen.
  const pinned = SLASH_PALETTE_PINNED
    .map((name) => rows.find((row) => row.value === `/${name}`))
    .filter((row): row is SlashPaletteEntry => row !== undefined && !row.detail.startsWith('unavailable · '))
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
    ['!<command>', 'run a shell command on this machine and carry its output into the next request'],
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
    { command: '!<command>', aliases: [], description: 'run a shell command and carry its output into the next request', group: 'Conversation' as const },
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

export type SlashRoute =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'command'; entry: SlashCommandEntry; head: string; args: string; words: string[] }
  | { kind: 'harness'; command: string; args: string }
  | { kind: 'manager'; name: string; args: string }
  | { kind: 'custom'; name: string; args: string }
  /** Forwarded to the active harness verbatim, as the prompt. */
  | { kind: 'native'; prompt: string; why: 'explicit' | 'passthrough' | 'advertised' }
  | { kind: 'unknown'; head: string; suggestion?: string };

/** Whether this route can be applied to a session while a turn is streaming.
 * Only the argument form: without one, `/model` is a picker and a picker
 * needs the screen the answer is being written on. */
export function slashRouteAppliesDuringTurn(route: SlashRoute, session?: HarnessSession): boolean {
  // `/model <id>` on ClikCode Local is not a state write: it loads a model,
  // which needs the waiting line the answer is using, and moving the lease
  // mid-turn could stop the server the running turn is talking to.
  if (route.kind === 'command' && route.entry.name === 'model' && session?.route === 'clikcode-local') return false;
  return route.kind === 'command' && route.entry.duringTurn === 'apply' && route.args.trim().length > 0;
}

/** Decide what one submitted line means. Precedence:
 *   1. not a slash line, or an existing filesystem path  -> prompt
 *   2. `//text`                                           -> native, verbatim `/text`
 *   3. registry command (incl. `/native <text>`)          -> command
 *   4. vendor manager, custom command, `/<harness>`       -> their own routes
 *   5. advertised by the ACP agent, or the harness declares
 *      `nativeSlashPassthrough`                           -> native, verbatim
 *   6. otherwise unknown, with a did-you-mean suggestion. */
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
