/**
 * What each slash command does, with no terminal involved.
 *
 * Every command has a headless body here that returns text, so the same
 * `/cost` or `/export` works typed into the chat, piped through the control
 * API, or run from a script -- and so there is exactly one definition of what
 * each one means. Commands that genuinely cannot run without a screen say so
 * rather than growing a second implementation.
 */
import { randomUUID } from 'node:crypto';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { commonControlFor } from './harness-options.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { captureNativeHarnessOutput } from './native-harness.js';
import { spawnPortable as spawn } from './spawn-portable.js';
import { failoverPrompt } from './ai-failover.js';
import type { AiLocalHarnessDefinition, HarnessSession, HarnessState } from './types.js';
import { harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, compactPath, sessionProviderLabel } from './native-harness-protocol.js';
import { accountView, harnessCommand, readState, resolveDefaultSettings, writeState } from './harness-state.js';
import { aiAccountLogin, aiAccountLogout, aiAccountRemove, aiDoctor } from './account-management.js';
import { closePersistentTransport, sessionNativeCommands, turnEnvironment } from './turn-runtime.js';
import { aiSessionSend } from './ai-turn.js';
import { emitHarnessOutput } from './harness-output.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from './harness-runtime.js';
import { copyToClipboard, decodeAttachmentPath, expandHomePath, queueAttachment } from './session-attachments.js';
import { conversationIdFor, hasConversationContent, optionForControl, requiresProviderHandoff, setSessionHarnessOption, VALID_PERMISSION_MODES } from './session-options.js';
import { routeSlashInput, slashControls, slashHelpText, unknownSlashMessage, type SlashExtras, type SlashHandlerKey, type SlashRouteContext } from './slash-registry.js';
import { customCommandPrompt, discoverCustomCommands, type CustomCommand } from './custom-commands.js';
import { sessionTranscriptMessages } from './turn-checkpoint.js';
import {
  aiHarnessSelect, aiSessionClose, aiSessionLeave, aiSettingsClearProvider, aiSettingsSetGlobal, aiSettingsSetProvider, applyFreshLocalSessionPolicy, applyGatewaySessionPolicy, newConversationSession, newProviderConversation,
} from './ai.js';


/** Shared slash-command grammar for a future TTY client and the headless CLI. */
export function sessionHarness(session: HarnessSession | undefined): AiLocalHarnessDefinition | undefined {
  return session?.route !== 'gateway' && session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
}

export function customCommandsFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): CustomCommand[] {
  if (session.route === 'gateway') return [];
  return discoverCustomCommands(harness, { workspace: session.workspace ?? process.cwd(), ...CUSTOM_COMMAND_ROOTS });
}
/** Test seam: redirect `~` and ClikCode's own command directories. */
export const CUSTOM_COMMAND_ROOTS: { home?: string; clikcodeDirs?: readonly string[] } = {};

export function slashExtrasFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): SlashExtras {
  const managers = harness ? localHarnessCapabilityManifest(harness).managers ?? {} : {};
  return {
    managers: Object.entries(managers).map(([name, manager]) => ({ name, label: manager?.label ?? name })),
    native: session.route === 'gateway' ? [] : sessionNativeCommands(session.id),
    custom: customCommandsFor(session, harness),
    harnesses: allLocalHarnesses().filter((item) => harnessCanRunTurns(item))
      .map((item, index) => ({ item, index })).sort((a, b) => harnessTierRank(a.item) - harnessTierRank(b.item) || a.index - b.index)
      .map(({ item }) => ({ command: item.command, displayName: item.displayName })),
  };
}

export function slashRouteContextFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined, pathExists?: (path: string) => boolean,
): SlashRouteContext {
  const extras = slashExtrasFor(session, harness);
  return {
    ...(harness ? { harness } : {}),
    harnessCommands: (extras.harnesses ?? []).map((item) => item.command),
    managerNames: (extras.managers ?? []).map((item) => item.name),
    nativeCommands: (extras.native ?? []).map((item) => item.name.replace(/^\//, '').toLowerCase()),
    customCommands: (extras.custom ?? []).map((item) => item.name),
    ...(pathExists ? { pathExists } : {}),
  };
}

function captureProcess(command: string, args: readonly string[], cwd?: string, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    if (stdinText !== undefined) child.stdin!.end(stdinText);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}

/** Everything that differs from the last commit: staged and unstaged changes
 * against HEAD, plus files git does not track yet (which `git diff` never shows). */
async function workspaceDiff(workspace: string): Promise<string> {
  const git = (args: readonly string[]): Promise<string> => captureProcess('git', args, workspace);
  const hasHead = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  // A repository with no commit yet has no HEAD: everything staged is the change.
  const base = hasHead ? ['diff', '--no-ext-diff', 'HEAD'] : ['diff', '--no-ext-diff', '--cached'];
  const [stat, details, untracked] = await Promise.all([
    git([...base, '--stat', '--', '.']), git([...base, '--', '.']),
    git(['ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => ''),
  ]);
  const untrackedFiles = untracked.split(/\r?\n/).filter(Boolean);
  const sections = [
    stat.trim(), details.trim(),
    untrackedFiles.length ? `Untracked files (${untrackedFiles.length}):\n${untrackedFiles.slice(0, 200).map((file) => `  ${file}`).join('\n')}${untrackedFiles.length > 200 ? `\n  … ${untrackedFiles.length - 200} more` : ''}` : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 512 * 1024);
}

export function capabilitiesText(session: HarnessSession): string {
  if (session.route === 'gateway') {
    return [
      'ClikDeploy Gateway capabilities',
      'Inference routing: platform managed',
      'Streaming: live SSE token deltas with bounded fallback chunking',
      'Tools: ClikDeploy capability registry and MCP bridge',
      'Permissions: authenticated server policy and confirmation gates',
      'Sessions: durable ClikCode transcript replay',
      'Models and effort: selected by Gateway routing policy',
    ].join('\n');
  }
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  return [
    `${harness.displayName} capabilities`,
    ...manifest.options.map((option) => {
      const control = commonControlFor(option.id);
      return `${option.label}: ${option.description}${control ? ` (${control})` : ''}`;
    }),
    ...Object.entries(manifest.managers ?? {}).map(([name, manager]) => `${manager?.label ?? name}: available`),
    ...(manifest.features ?? []).map((feature) => `${feature}: native`),
  ].join('\n');
}

function memoryFileName(session: HarnessSession): string {
  return sessionHarness(session)?.memoryFile ?? 'AGENTS.md';
}

export function initPrompt(session: HarnessSession): string {
  const file = memoryFileName(session);
  return `Inspect this repository and create or improve ${file} with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.`;
}

export function reviewPrompt(extra: string): string {
  return `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`;
}

export async function readMemoryFile(session: HarnessSession): Promise<{ path: string; content?: string }> {
  const path = join(session.workspace ?? process.cwd(), memoryFileName(session));
  try {
    return { path, content: (await readFile(path, 'utf8')).slice(0, 256 * 1024) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    throw error;
  }
}

function undoUnavailableMessage(session: HarnessSession): string {
  const harness = sessionHarness(session);
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : harness?.displayName ?? 'This provider';
  return `${who} does not expose an undo/rewind operation to ClikCode, so /undo is not available here. ClikCode will not fake it: use /diff to see what changed and git to revert it${harness?.nativeSlashPassthrough ? `, or send the vendor's own command with //rewind` : ''}.`;
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

function contextUsageText(session: HarnessSession): string {
  const usage = session.lastUsage;
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : sessionHarness(session)?.displayName ?? 'The provider';
  if (!usage) return `${who} has not reported token usage for this conversation yet. It appears here after a turn on a harness that publishes usage events.`;
  const used = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const window = usage.contextWindow;
  return [
    `Context usage (as of ${usage.at})`,
    window && used !== undefined ? `  window     ${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)` : `  window     not reported by ${who}`,
    `  input      ${formatTokens(usage.inputTokens)}`,
    `  cached     ${formatTokens(usage.cacheReadTokens)}`,
    `  output     ${formatTokens(usage.outputTokens)}`,
    `  total      ${formatTokens(used)}`,
    `  messages   ${sessionTranscriptMessages(session).length}`,
  ].join('\n');
}

function costReport(state: HarnessState, session: HarnessSession): { text: string; totals: { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean } } {
  const invocations = state.invocations.filter((item) => item.sessionId === session.id);
  const totals = invocations.reduce((sum, item) => ({
    turns: sum.turns + 1, inputTokens: sum.inputTokens + (item.inputTokens ?? 0), outputTokens: sum.outputTokens + (item.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (item.cacheReadTokens ?? 0), costUsd: sum.costUsd + (item.costUsd ?? 0),
    costKnown: sum.costKnown || item.costUsd !== undefined,
  }), { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, costKnown: false });
  const text = invocations.length
    ? [
      'This conversation',
      `  turns      ${totals.turns}`,
      `  input      ${formatTokens(totals.inputTokens)} tokens`,
      `  cached     ${formatTokens(totals.cacheReadTokens)} tokens`,
      `  output     ${formatTokens(totals.outputTokens)} tokens`,
      `  cost       ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : 'not reported (subscription plans and most vendor CLIs do not publish a price)'}`,
    ].join('\n')
    : 'No metered turns recorded for this conversation yet.';
  return { text, totals };
}

function transcriptMarkdown(session: HarnessSession): string {
  const title = session.name ?? `ClikCode conversation ${session.id.slice(0, 8)}`;
  const header = [
    `# ${title}`, '',
    `- Provider: ${sessionProviderLabel(session)}`,
    `- Model: ${session.model ?? 'provider default'}`,
    `- Workspace: ${session.workspace ?? process.cwd()}`,
    `- Exported: ${new Date().toISOString()}`, '',
  ];
  const body = sessionTranscriptMessages(session).flatMap((message) => [`## ${message.role === 'assistant' ? 'Assistant' : 'You'}`, '', message.content.trim(), '']);
  return `${[...header, ...body].join('\n').trimEnd()}\n`;
}

/** Never overwrites silently: `confirmOverwrite` decides (a prompt in the TUI,
 * `--force` headless). */
export async function exportTranscript(session: HarnessSession, target: string, confirmOverwrite: (path: string) => Promise<boolean>): Promise<string> {
  const workspace = session.workspace ?? process.cwd();
  const requested = expandHomePath(decodeAttachmentPath(target.trim() || `clikcode-${session.id.slice(0, 8)}.md`));
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory()) throw new Error(`${compactPath(path)} is a directory; give a file name.`);
  if (existing && !await confirmOverwrite(path)) throw new Error(`${compactPath(path)} already exists; not overwritten. Choose another path${isJsonDefaultMode() ? ' or pass --force' : ''}.`);
  await writeFile(path, transcriptMarkdown(session), { encoding: 'utf8', mode: 0o600 });
  return path;
}

async function resolveExistingDirectory(session: HarnessSession, raw: string): Promise<string> {
  const expanded = expandHomePath(decodeAttachmentPath(raw));
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(session.workspace ?? process.cwd(), expanded);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${compactPath(path)} does not exist.`);
  if (!info.isDirectory()) throw new Error(`${compactPath(path)} is not a directory.`);
  return path;
}

/** A native session belongs to the directory it was started in, so moving the
 * conversation drops it (the transcript is replayed into the next one) and
 * closes any live transport child, whose cwd is fixed at spawn. */
async function changeSessionWorkspace(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  const path = await resolveExistingDirectory(session, raw);
  if (path === (session.workspace ?? process.cwd())) return `Already working in ${compactPath(path)}.`;
  const droppedNative = Boolean(session.nativeSessionId);
  session.workspace = path;
  session.nativeSessionId = undefined;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  await closePersistentTransport(session.id);
  return `Working directory is now ${compactPath(path)}.${droppedNative ? ' The native session belonged to the previous directory, so the next turn starts a fresh one with this conversation replayed.' : ''}`;
}

/** Stored as the harness's own declared `add-dir` option, so every transport
 * renders it the way the catalog says. No declaration, no pretending. */
async function addSessionDirectory(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  if (!raw.trim()) throw new Error('usage: /add-dir <dir>');
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider before adding directories.');
  const option = optionForControl(harness, '/add-dir');
  if (!option) throw new Error(`${harness.displayName} does not declare an additional-directory option; start ClikCode from a common parent directory or use /cwd instead.`);
  const path = await resolveExistingDirectory(session, raw);
  const current = session.harnessOptions?.[option.id];
  const existing = Array.isArray(current) ? current.map(String) : typeof current === 'string' && current ? [current] : [];
  if (existing.includes(path)) return `${compactPath(path)} is already available to ${harness.displayName}.`;
  session.harnessOptions = { ...session.harnessOptions, [option.id]: option.kind === 'path-list' || option.kind === 'string-list' ? [...existing, path] : path };
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // A live ACP child took its option argv at spawn.
  await closePersistentTransport(session.id);
  return `${harness.displayName} can now also work in ${compactPath(path)}.`;
}

const COMPACT_PROMPT = 'Summarize this conversation so far for a fresh session that will continue the work. Include: the goal, decisions made and why, files created or changed (with paths), commands that matter, the current state, and the concrete next steps. Be complete but concise. Output only the summary.';

/** `/compact`. A harness that runs slash commands itself compacts natively.
 * Otherwise ClikCode does it: one turn produces the summary, then a fresh
 * branch of the same conversation is seeded with only that summary -- with no
 * native session id, so its first turn replays the summary into a brand-new
 * vendor session. The full transcript stays on the original, resumable. */
export async function compactConversation(
  id: string, session: HarnessSession, focus: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<string | void> {
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway manages its own context; /compact applies only to local harnesses.');
  if (!hasConversationContent(session)) throw new Error('There is nothing to compact yet.');
  const harness = sessionHarness(session);
  if (harness?.nativeSlashPassthrough && session.nativeSessionId) {
    await send(id, `/compact${focus ? ` ${focus}` : ''}`);
    return;
  }
  await send(id, `${COMPACT_PROMPT}${focus ? `\nPay particular attention to: ${focus}` : ''}`);
  const state = await readState();
  const source = state.sessions.find((item) => item.id === id);
  if (!source) throw new Error(`AI session "${id}" was not found`);
  const summary = [...sessionTranscriptMessages(source)].reverse().find((message) => message.role === 'assistant')?.content.trim();
  if (!summary) throw new Error('The provider returned no summary; the conversation was left as it was.');
  const compacted: HarnessSession = {
    ...newConversationSession(state, source),
    conversationId: conversationIdFor(source), parentSessionId: source.id,
    ...(source.name ? { name: source.name } : {}),
    ...(source.harnessOptions ? { harnessOptions: { ...source.harnessOptions } } : {}),
    messages: [
      { role: 'user', content: 'Summary of the conversation so far (compacted by ClikCode):' },
      { role: 'assistant', content: summary },
    ],
  };
  state.sessions.push(compacted);
  await writeState(state);
  await closePersistentTransport(id);
  return compacted.id;
}

export async function nativeManagerListing(state: HarnessState, session: HarnessSession, name: string): Promise<{ label: string; text: string }> {
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manager = (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[] } | undefined> | undefined)?.[name];
  if (!manager) throw new Error(`${harness.displayName} does not publish a ${name} manager.`);
  if (!manager.listArgv) throw new Error(`${harness.displayName} manages ${manager.label} only in its own interactive UI; open it from the interactive ClikCode session.`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const text = await captureNativeHarnessOutput(harness, manager.listArgv, turnEnvironment(harness, account), 15_000, session.workspace);
  return { label: manager.label, text: text.trim() || 'No entries.' };
}

/** What one slash command did, for a caller that must follow it. */
interface HeadlessSlashContext {
  id: string; state: HarnessState; session: HarnessSession;
  /** Canonical registry name (aliases already resolved). */
  head: string; args: string; words: string[];
}
/** Resolves with the resulting session id when the command moved the
 * conversation to another session (`/new`, a handoff), otherwise nothing. */
type HeadlessSlashHandler = (context: HeadlessSlashContext) => Promise<string | void>;

const INTERACTIVE_ONLY = (name: string): HeadlessSlashHandler => async () => {
  throw new Error(`/${name} opens a picker and is only available in the interactive ClikCode session.`);
};

/** Indirection so the interactive loop and tests can observe/replace the turn. */
export const SLASH_TURN = { send: (id: string, prompt: string): Promise<void> => aiSessionSend(id, prompt) };
const sendSessionTurn = (id: string, prompt: string): Promise<void> => SLASH_TURN.send(id, prompt);

/** Headless half of the slash registry. Typed by SlashHandlerKey, so a
 * registry entry without a handler here (or a handler without an entry) does
 * not compile; slash-registry.vitest.test.ts asserts the same at runtime. */
export const HEADLESS_SLASH_HANDLERS: Record<SlashHandlerKey, HeadlessSlashHandler> = {
  help: async ({ session }) => {
    const harness = sessionHarness(session);
    const extras = slashExtrasFor(session, harness);
    return emitHarnessOutput({ panel: 'help', helpText: slashHelpText(session, harness, extras), controls: slashControls() });
  },
  status: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    return emitHarnessOutput({ panel: 'settings', session, account });
  },
  new: async ({ state, session, args }) => {
    // `/reset` and `/clear` are aliases, not an in-place wipe. Clearing the
    // transcript on the existing record destroyed history with no confirmation.
    // A fresh conversation gives the same clean slate and keeps the previous
    // one resumable. Text after the command is the new conversation's first
    // turn, sent ON the new session -- it used to be dropped, leaving an orphan.
    const created = newConversationSession(state, session);
    state.sessions.push(created);
    await writeState(state);
    if (!args) emitHarnessOutput({ panel: 'conversation-reset', session: created });
    else await sendSessionTurn(created.id, args);
    return created.id;
  },
  permissions: async ({ state, session, words }) => {
    if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy; Ask, Bypass, and Auto apply only to local harnesses.');
    const value = words.shift()?.toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting permissions.');
    if (!value) {
      const controls = VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode));
      if (!controls.length) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag.`);
      return emitHarnessOutput({ panel: 'permissions', session, controls });
    }
    setSessionHarnessOption(session, harness, 'permissions', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  history: async ({ session }) => {
    return emitHarnessOutput({ panel: 'history', messages: sessionTranscriptMessages(session) });
  },
  copy: async ({ session }) => {
    const last = sessionTranscriptMessages(session).reverse().find((message) => message.role === 'assistant');
    if (!last) throw new Error('There is no assistant response to copy yet.');
    const via = await copyToClipboard(last.content);
    return emitHarnessOutput({ panel: 'copied', text: via === 'osc52' ? 'Last response sent to your terminal clipboard (OSC 52).' : 'Last response copied to the clipboard.' });
  },
  mention: async ({ state, session, words }) => {
    const action = words.join(' ').trim();
    if (!action) return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
    if (action === 'clear') {
      session.attachments = [];
    } else {
      const unquoted = decodeAttachmentPath(action);
      const workspace = session.workspace ?? process.cwd();
      const expanded = expandHomePath(unquoted);
      const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
      await queueAttachment(session, path);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
  },
  diff: async ({ session }) => {
    return emitHarnessOutput({ panel: 'diff', diff: await workspaceDiff(session.workspace ?? process.cwd()) });
  },
  review: async ({ id, session, head, words }) => {
    // Gateway refusal lives in the registry's availability(), shared by both dispatchers.
    return sendSessionTurn(id, head === 'review' ? reviewPrompt(words.join(' ').trim()) : initPrompt(session));
  },
  rename: async ({ state, session, words }) => {
    const name = words.join(' ').trim();
    if (!name) throw new Error('Enter a name after /rename.');
    session.name = name.slice(0, 120);
    session.nameSource = 'user';
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-renamed', text: `Conversation renamed to “${session.name}”.` });
  },
  archive: async ({ state, session }) => {
    session.status = 'archived';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
  },
  delete: async ({ id, state, session, words }) => {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  },
  fork: async ({ id, state, session, words }) => {
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id,
      messages: sessionTranscriptMessages(session), pendingTurn: undefined,
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A fork is a sibling concept, not another copy of the handoff event that
    // created its parent. Its parentSessionId is sufficient ancestry.
    delete fork.handoff;
    state.sessions.push(fork);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-forked', text: `Conversation forked as ${fork.id.slice(0, 8)}. Use /resume to open it.`, session: fork });
  },
  model: async ({ state, session, words }) => {
    const value = words.join(' ').trim();
    if (!value) throw new Error('Choose a model from /model or use /model <name>.');
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    session.model = value === 'default' || value === 'auto' ? null : value;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    setSessionHarnessOption(session, harness, 'effort', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  account: async ({ id, words }) => {
    return aiSessionCommand(id, words.length ? `/accounts use ${words.join(' ')}` : '/accounts');
  },
  sessions: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    const targetId = words.shift();
    if (action === 'close') {
      if (!targetId) throw new Error('usage: /sessions close <id>');
      return aiSessionClose(targetId);
    }
    if (action === 'show' || action === 'open' || action === 'resume') {
      if (!targetId) throw new Error(`usage: /sessions ${action} <id>`);
      const target = state.sessions.find((item) => item.id === targetId);
      if (!target) throw new Error(`AI session "${targetId}" was not found`);
      return emitHarnessOutput({ panel: 'session', session: target, next: `${harnessCommand()} sessions open ${target.id}` });
    }
    if (action && action !== 'list' && action !== 'ls') throw new Error('usage: /sessions [list|show <id>|open <id>|close <id>]');
    return emitHarnessOutput({
      panel: 'sessions',
      sessions: state.sessions.map((item) => ({
        id: item.id, status: item.status, harness: item.nativeHarness, nativeSessionId: item.nativeSessionId,
        provider: item.provider, model: item.model, workspace: item.workspace, updatedAt: item.updatedAt,
      })),
      controls: ['sessions list', 'sessions open <id>', 'sessions close <id>'],
    });
  },
  models: async ({ state, session }) => {
    return emitHarnessOutput({
      panel: 'models',
      models: state.accounts.flatMap((account) => account.models.map((model) => ({ account: account.label, provider: account.provider, model }))),
      selected: session.model,
    });
  },
  usage: async ({ state, session }) => {
    const invocations = state.invocations.filter((invocation) => invocation.accountId === session.accountId || (session.route === 'gateway' && invocation.accountId === 'gateway'));
    return emitHarnessOutput({
      panel: 'usage', invocations,
      totals: invocations.reduce((total, invocation) => ({ calls: total.calls + 1, inputTokens: total.inputTokens + (invocation.inputTokens ?? 0), outputTokens: total.outputTokens + (invocation.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, outputTokens: 0 }),
    });
  },
  settings: async ({ id, state, session, words }) => {
    const setting = words.shift()?.toLowerCase();
    const value = words.join(' ').trim();
    if (!setting) return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
    if (setting === 'global') {
      const [key, ...rest] = words;
      if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|failover> <value>');
      await aiSettingsSetGlobal(key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `Global default updated: ${key} = ${rest.join(' ')}` });
    }
    if (setting === 'provider') {
      const [providerId, key, ...rest] = words;
      if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions|failover> <value>, or /settings provider <id> clear');
      if (key.toLowerCase() === 'clear') {
        await aiSettingsClearProvider(providerId, false);
        return emitHarnessOutput({ panel: 'settings-updated', text: `Provider defaults cleared for ${providerId}` });
      }
      if (!rest.length) throw new Error('usage: /settings provider <id> <key> <value>');
      await aiSettingsSetProvider(providerId, key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `${providerId} default updated: ${key} = ${rest.join(' ')}` });
    }
    if (!value) throw new Error(`usage: /settings ${setting} <value>`);
    if (setting === 'route') {
      if (value !== 'local' && value !== 'gateway') throw new Error('route must be local or gateway');
      if (value === 'gateway') applyGatewaySessionPolicy(session);
      else if (session.route === 'gateway') applyFreshLocalSessionPolicy(state, session);
      else session.route = 'local';
    } else if (setting === 'account') {
      const account = state.accounts.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase());
      if (!account) throw new Error(`local AI account "${value}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
    } else if (setting === 'model') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
      session.model = value === 'default' || value === 'auto' ? null : value;
    } else if (setting === 'effort') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting effort.');
      setSessionHarnessOption(session, harness, 'effort', value);
    } else if (setting === 'permissions' || setting === 'permission') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting permissions.');
      setSessionHarnessOption(session, harness, 'permissions', value);
    } else if (setting === 'option') {
      const [optionId, ...optionValue] = value.split(/\s+/);
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness || !optionId || !optionValue.length) throw new Error('usage: /settings option <id> <value>');
      setSessionHarnessOption(session, harness, optionId, optionValue.join(' '));
    } else if (setting === 'accountfailover' || setting === 'account-failover') {
      if (value !== 'never' && value !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
      session.accountFailover = value;
    } else if (setting === 'native-session') {
      if (!session.nativeHarness) throw new Error('select a native harness before attaching its session id');
      const selectedHarness = localHarnessForCommand(session.nativeHarness);
      if (!selectedHarness?.session?.resumeIdPrefix) throw new Error(`${selectedHarness?.displayName ?? session.nativeHarness} does not support exact session resume`);
      session.nativeSessionId = value;
    } else {
      throw new Error(`unknown setting: ${setting}`);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  accounts: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    if (action === 'use' || action === 'select') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts use <label-or-id>');
      const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
      if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      if (session.nativeHarness) {
        const selectedHarness = localHarnessForCommand(session.nativeHarness);
        if (selectedHarness && selectedHarness.provider !== account.provider) throw new Error(`account "${account.label}" belongs to ${account.provider}; select /${localHarnessForProvider(account.provider)?.command ?? account.provider} first`);
      }
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      // Explicit selection is the user's retry signal for an account previously
      // marked exhausted. Automatic routing never guesses a reset time.
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', selected: accountView(account), session });
    }
    if (action === 'login') {
      const harnessName = words.shift()?.toLowerCase();
      if (!harnessName) throw new Error('usage: /accounts login <harness> [label]');
      await aiAccountLogin(harnessName, words.join(' ') || undefined);
      return;
    }
    if (action === 'remove' || action === 'rm') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts remove <label-or-id>');
      return aiAccountRemove(labelOrId);
    }
    if (action === 'add') {
      const shortcut = words.shift()?.toLowerCase();
      const provider = shortcut ? (localHarnessForCommand(shortcut)?.provider ?? shortcut) : undefined;
      if (!provider) throw new Error('usage: /accounts add <harness>');
      const knownHarness = shortcut ? localHarnessForCommand(shortcut) : undefined;
      if (knownHarness?.surface === 'terminal') { await aiAccountLogin(knownHarness.command, words.join(' ') || undefined); return; }
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth oauth|api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    if (action === 'failover') {
      const setting = words.shift();
      if (setting !== 'auto' && setting !== 'never') throw new Error('usage: /accounts failover auto|never');
      session.accountFailover = setting === 'auto' ? 'on-quota-exhausted' : 'never';
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', session, accountFailover: session.accountFailover });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['use <label-or-id>', 'login <harness> [label]', 'add <harness> [label]', 'remove <label-or-id>', 'failover auto|never'] });
  },
  gateway: async ({ state, session }) => {
    if (sessionTranscriptMessages(session).length || session.nativeSessionId) {
      throw new Error('Use the interactive /provider menu to hand off an existing conversation to ClikDeploy Gateway.');
    }
    applyGatewaySessionPolicy(session);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'clikdeploy-gateway', account: null, model: 'platform', centralized: true });
  },
  attachments: (context) => HEADLESS_SLASH_HANDLERS.mention(context),
  init: (context) => HEADLESS_SLASH_HANDLERS.review(context),
  redraw: async () => emitHarnessOutput({ panel: 'redraw', text: 'Nothing to repaint outside the interactive session.' }),
  exit: async ({ id }) => aiSessionLeave(id),
  provider: INTERACTIVE_ONLY('provider'),
  resume: INTERACTIVE_ONLY('resume'),
  options: INTERACTIVE_ONLY('options'),
  capabilities: async ({ session }) => emitHarnessOutput({ panel: 'capabilities', text: capabilitiesText(session) }),
  native: async ({ id, session, args }) => {
    if (!args) throw new Error('usage: /native <text>  (or //text)');
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, args);
  },
  compact: async ({ id, session, args }) => compactConversation(id, session, args, sendSessionTurn),
  context: async ({ session }) => emitHarnessOutput({ panel: 'context', text: contextUsageText(session), usage: session.lastUsage ?? null }),
  cost: async ({ state, session }) => {
    const report = costReport(state, session);
    return emitHarnessOutput({ panel: 'cost', text: report.text, totals: report.totals });
  },
  export: async ({ session, words }) => {
    const force = words.includes('--force');
    const path = await exportTranscript(session, words.filter((word) => word !== '--force').join(' '), async () => force);
    return emitHarnessOutput({ panel: 'exported', text: `Transcript written to ${compactPath(path)}.`, path });
  },
  cwd: async ({ state, session, args }) => {
    if (!args) return emitHarnessOutput({ panel: 'cwd', text: compactPath(session.workspace ?? process.cwd()), workspace: session.workspace ?? process.cwd() });
    const notice = await changeSessionWorkspace(state, session, args);
    return emitHarnessOutput({ panel: 'cwd', text: notice, workspace: session.workspace });
  },
  'add-dir': async ({ state, session, args }) => emitHarnessOutput({ panel: 'add-dir', text: await addSessionDirectory(state, session, args) }),
  memory: async ({ session, words }) => {
    if (words[0]?.toLowerCase() === 'edit') throw new Error('/memory edit opens $EDITOR and is only available in the interactive ClikCode session.');
    const memory = await readMemoryFile(session);
    return emitHarnessOutput({ panel: 'memory', text: `${compactPath(memory.path)}\n\n${memory.content ?? '(not created yet — /init writes it)'}`, path: memory.path, exists: memory.content !== undefined });
  },
  doctor: async () => aiDoctor(),
  login: async ({ session }) => {
    const harness = sessionHarness(session);
    if (!harness) throw new Error('Choose a provider before signing in.');
    await aiAccountLogin(harness.command);
  },
  logout: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (!account) throw new Error('This conversation has no account to sign out.');
    await aiAccountLogout(account.id);
  },
  undo: async ({ session }) => { throw new Error(undoUnavailableMessage(session)); },
};

export async function aiSessionCommand(id: string, input: string): Promise<string> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const text = input.trim();
  if (!text.replace(/^\/+/, '')) throw new Error('slash command is required');
  const harness = sessionHarness(session);
  const route = routeSlashInput(text.startsWith('/') ? text : `/${text}`, slashRouteContextFor(session, harness));
  if (route.kind === 'command') {
    const availability = route.entry.availability(session, harness);
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const moved = await HEADLESS_SLASH_HANDLERS[route.entry.handlerKey]({ id, state, session, head: route.entry.name, args: route.args, words: [...route.words] });
    return typeof moved === 'string' ? moved : id;
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: a conversation with content hands off to a new
    // branch. The caller must follow the returned id -- the interactive loop
    // adopts it; the turn, if any, runs on THAT session.
    const targetId = requiresProviderHandoff(session, route.command)
      ? await newProviderConversation(id, route.command)
      : id;
    if (targetId === id) await aiHarnessSelect(route.command, targetId);
    if (route.args) await sendSessionTurn(targetId, route.args);
    return targetId;
  }
  if (route.kind === 'manager') {
    const listing = await nativeManagerListing(state, session, route.name);
    emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
    return id;
  }
  if (route.kind === 'custom') {
    const command = customCommandsFor(session, harness).find((item) => item.name === route.name);
    if (!command) throw new Error(`custom command /${route.name} is no longer available`);
    await sendSessionTurn(id, customCommandPrompt(command, route.args, harness));
    return id;
  }
  if (route.kind === 'native') {
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, route.prompt);
    return id;
  }
  if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
  throw new Error('slash command is required');
}
