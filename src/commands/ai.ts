/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Conf from 'conf';
import chalk from 'chalk';
import { ApiClient } from '../api/client.js';
import { login } from './auth.js';
import { emitJson } from '../utils/structured-output.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { captureNativeHarness, captureNativeHarnessOutput, captureNativeHarnessTurn, ensureNativeHarness, inspectNativeHarness, loginNativeHarness, runNativeHarnessCommand } from './native-harness.js';
import { classifyAccountFailure, failoverPrompt } from './ai-failover.js';
import {
  ADOPTED_TRANSCRIPT_READERS, conversationTitle, discoverNativeSessions, FS_SESSION_DISCOVERY, mergeNativeTranscript, type DiscoveredNativeSession,
} from './native-session-discovery.js';
import type {
  AiHarnessAccount, AiHarnessAuthKind, AiHarnessCapabilityManifest, AiHarnessOptionDefinition,
  AiHarnessOptionKind, AiHarnessPermissionMode, AiHarnessRoute, AiLocalHarnessDefinition, AiRouterRuntime,
  FormattedParagraph, HarnessActivityEvent, HarnessDefaultSettings, HarnessPrompter, HarnessSession,
  HarnessState, MessageBlock, ModelCatalogResult, NativeUsageProbe, PickerOption,
} from './types.js';
import {
  composerViewport, formatParagraph, nextCharacterIndex, previousCharacterIndex,
  renderInlineMarkdown, splitIntoBlocks, styleWords, terminalCellWidth, visibleSlice, wrapWords,
} from './markdown-render.js';
import {
  capDiffLines, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode,
  isCodeChangeLabel, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider,
  localRouter, nativeActivityPhase, nativeResponseUpdate, nativeSessionIds, nativeTurnResult, parseNativeActivityEvent,
  compactPath, nativeProfileEnvironment, renderActivityLine, renderActivityPhase, sessionProviderLabel, streamLocalAiTurn,
} from './native-harness-protocol.js';
import {
  accountView, deviceManifest, harnessCommand, harnessStatePath, readState, resolveDefaultSettings, writeState,
} from './harness-state.js';
import {
  accountUsageLabel, nativeModelCatalog, nativeModelLabel, nativeUsageLabel,
} from './native-account-data.js';
import {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor, announceBareInteractiveLogin, deriveAccountLabel, harnessNeedsLogin, syncAccountIdentityAfterLogin,
  nativeAccountContext, setEmitHarnessOutput,
} from './account-management.js';
import { FullScreenHarnessPrompter } from './terminal-ui.js';
import { runCodexAppServerTurn } from './codex-app-server.js';
export {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor,
};





let activeFullScreenHarness: FullScreenHarnessPrompter | undefined;

function conversationIdFor(session: HarnessSession): string {
  return session.conversationId ?? session.id;
}

function hasConversationContent(session: HarnessSession): boolean {
  return Boolean(session.nativeSessionId || (session.messages ?? []).length > 0);
}

export function requiresProviderHandoff(session: HarnessSession, targetHarness: string): boolean {
  return hasConversationContent(session) && (session.route !== 'local' || session.nativeHarness !== targetHarness);
}

/** Pick the branch ClikCode should restore when it starts without an explicit
 * session id. Leaving the application keeps the current branch active; only
 * the explicit session-close action removes a branch from this candidate set. */
export function defaultSessionCandidate(sessions: readonly HarnessSession[]): HarnessSession | undefined {
  return [...sessions]
    .filter((session) => session.status === 'active')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

/** Leaving the foreground application is not the same operation as closing a
 * conversation. Touch the current branch so it remains the default branch on
 * the next launch, without changing its provider-owned session identity. */
export function markSessionLeftOpen(session: HarnessSession, now: string): void {
  session.status = 'active';
  delete session.closedAt;
  session.updatedAt = now;
}

/** Historical lookup retained for migration/diagnostics. Normal provider
 * switching no longer reopens an older provider branch because that branch
 * predates the conversation's current tip; a new handoff continues the full
 * latest transcript instead. */
export function establishedProviderBranch(
  sessions: readonly HarnessSession[],
  current: HarnessSession,
  targetHarness: string,
): HarnessSession | undefined {
  return [...sessions]
    .filter((session) => session.id !== current.id
      && conversationIdFor(session) === conversationIdFor(current)
      && session.nativeHarness === targetHarness
      && Boolean(session.nativeSessionId))
    .sort((left, right) => {
      const messageDifference = (right.messages?.length ?? 0) - (left.messages?.length ?? 0);
      return messageDifference || right.updatedAt.localeCompare(left.updatedAt);
    })[0];
}

/** Create a portable child branch. The source keeps its provider-owned
 * identity; the child carries the ClikCode-owned transcript into its target. */
export function createHandoffBranch(input: {
  source: HarnessSession;
  target: AiLocalHarnessDefinition;
  accountId: string | null;
  model: string | null;
  defaults: HarnessDefaultSettings;
  now: string;
  id?: string;
  sourceDisplayName?: string;
}): HarnessSession {
  const sourceCommand = input.source.nativeHarness ?? input.source.route;
  const id = input.id ?? randomUUID();
  const base = input.source.name?.replace(/\s+\(from [^)]+\)$/i, '').trim();
  return {
    id, conversationId: conversationIdFor(input.source), parentSessionId: input.source.id,
    handoff: { fromSessionId: input.source.id, fromHarness: sourceCommand, at: input.now },
    route: 'local', accountId: input.accountId, provider: input.target.provider, model: input.model,
    effort: input.defaults.effort, permissionMode: input.defaults.permissionMode, accountFailover: input.defaults.accountFailover,
    workspace: input.source.workspace ?? process.cwd(), nativeHarness: input.target.command,
    ...(base ? { name: base } : {}),
    ...(input.source.messages?.length ? { messages: input.source.messages.map((message) => ({ ...message })) } : {}),
    createdAt: input.now, updatedAt: input.now, status: 'active',
  };
}

/** One row per ClikCode conversation. Provider-native hops stay available via
 * the row's right-arrow history instead of appearing as duplicate/fork rows. */
export function sessionPickerOptions(
  sessions: readonly HarnessSession[],
  currentId: string,
  providerLabel: (session: HarnessSession) => string = sessionProviderLabel,
): PickerOption<string>[] {
  const groups = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    const root = conversationIdFor(session);
    const group = groups.get(root) ?? [];
    group.push(session);
    groups.set(root, group);
  }
  const timestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.updatedAt);
    return Number.isNaN(value) ? -Infinity : value;
  };
  const createdTimestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.createdAt);
    return Number.isNaN(value) ? timestamp(session) : value;
  };
  const orderedGroups = [...groups.values()].sort((left, right) =>
    Math.max(...right.map(timestamp)) - Math.max(...left.map(timestamp)));

  return orderedGroups.map((group) => {
    const history = [...group].sort((left, right) => createdTimestamp(left) - createdTimestamp(right));
    const active = group.filter((session) => session.status === 'active');
    const latest = [...(active.length ? active : group)].sort((left, right) => timestamp(right) - timestamp(left))[0]!;
    const title = latest.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || 'Untitled chat';
    const model = nativeModelLabel(latest.nativeHarness, latest.model);
    return {
      label: title,
      detail: `· ${providerLabel(latest)}${group.some((session) => session.id === currentId) ? ' · current' : ''} · ${model ?? 'automatic'} · ${new Date(latest.updatedAt).toLocaleString()}${history.length > 1 ? ` · → ${history.length} provider sessions` : ''}`,
      value: latest.id,
      actions: history.length > 1 ? history.map((session, index) => ({
        label: `${providerLabel(session)} · ${session.id === latest.id ? 'latest' : index === 0 ? 'original' : 'continued'} · ${new Date(session.updatedAt).toLocaleString()}`,
        value: session.id,
      })) : undefined,
    };
  });
}

export function interruptedTurnMessages(
  messages: NonNullable<HarnessSession['messages']>, prompt: string, partialResponse: string, outputStarted: boolean,
): NonNullable<HarnessSession['messages']> {
  if (!outputStarted) return messages;
  const next = [...messages, { role: 'user' as const, content: prompt }];
  if (partialResponse) next.push({ role: 'assistant', content: partialResponse });
  return next;
}

async function preserveInterruptedTurn(id: string, prompt: string, partialResponse: string, outputStarted: boolean): Promise<void> {
  if (!outputStarted) return;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  session.messages = interruptedTurnMessages(session.messages ?? [], prompt, partialResponse, outputStarted);
  session.name ??= conversationTitle(prompt);
  session.attachments = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

/** Pull turns added directly in a vendor CLI back into an already-linked
 * ClikCode conversation. The native CLI remains the only writer of its own
 * files; this only reconciles ClikCode's cached view after an exact-id resume. */
async function synchronizeNativeTranscript(state: HarnessState, session: HarnessSession): Promise<boolean> {
  if (!session.nativeHarness || !session.nativeSessionId) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  const reader = harness ? ADOPTED_TRANSCRIPT_READERS[harness.command] : undefined;
  if (!harness || !reader) return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const source = await reader(
    harness, session.nativeSessionId, session.workspace ?? process.cwd(), nativeProfileEnvironment(account?.nativeProfile),
  ).catch(() => []);
  const merged = mergeNativeTranscript(session.messages ?? [], source);
  if (merged.length === (session.messages ?? []).length) return false;
  session.messages = merged;
  const firstUserMessage = merged.find((message) => message.role === 'user')?.content;
  if (!session.name && firstUserMessage) session.name = conversationTitle(firstUserMessage);
  session.updatedAt = new Date().toISOString();
  return true;
}

/** Gateway routing owns these fields as one policy unit. Keeping the mutation
 * centralized prevents route switches, slash settings, and headless setters
 * from leaving stale local harness/account controls attached to a remote
 * platform-managed session. */
function applyGatewaySessionPolicy(session: HarnessSession): void {
  session.route = 'gateway';
  session.accountId = null;
  session.provider = 'clikdeploy-gateway';
  session.model = null;
  session.effort = 'platform-managed';
  session.accountFailover = 'never';
  session.gatewayConfirmed = true;
  delete session.permissionMode;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

function applyFreshLocalSessionPolicy(state: HarnessState, session: HarnessSession): void {
  const defaults = resolveDefaultSettings(state, null);
  session.route = 'local';
  session.accountId = null;
  session.provider = null;
  session.model = null;
  session.effort = defaults.effort;
  session.permissionMode = defaults.permissionMode;
  session.accountFailover = defaults.accountFailover;
  delete session.gatewayConfirmed;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

function line(label: string, value: unknown): string {
  return `  ${chalk.dim(label.padEnd(10))}${String(value ?? '—')}`;
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

async function copyToClipboard(text: string): Promise<void> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  let lastError: unknown;
  for (const [command, args] of candidates) {
    try { await captureProcess(command, args, undefined, text); return; } catch (error) { lastError = error; }
  }
  throw new Error(`No supported clipboard command is available${lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '.'}`);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Decode a path as entered or dragged into a terminal without invoking a
 * shell. Drag-and-drop commonly adds quotes or backslashes before spaces. */
export function decodeAttachmentPath(input: string): string {
  let value = input.trim();
  const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (quoted) value = quoted[1] ?? quoted[2] ?? '';
  if (value.startsWith('file://')) {
    try { return fileURLToPath(value); } catch { return value; }
  }
  // Backslashes are path separators on Windows, but terminal escape
  // characters on the Unix platforms where drag-and-drop produces them.
  return process.platform === 'win32' ? value : value.replace(/\\(.)/g, '$1');
}

/** Resolve a standalone input only when it clearly looks like a file
 * reference and names an existing regular file. This preserves slash
 * commands while allowing absolute image paths such as /home/me/photo.png. */
export async function resolveStandaloneAttachment(
  input: string,
  workspace: string,
): Promise<string | undefined> {
  const raw = input.trim();
  const decoded = decodeAttachmentPath(raw);
  const explicitlyQuoted = /^(?:"[\s\S]*"|'[\s\S]*')$/.test(raw);
  const looksLikePath = raw.startsWith('file://')
    || isAbsolute(decoded)
    || decoded.startsWith('./')
    || decoded.startsWith('../')
    || decoded.startsWith('~/')
    || explicitlyQuoted
    || IMAGE_EXTENSIONS.has(extname(decoded).toLowerCase());
  if (!looksLikePath) return undefined;
  const expanded = decoded === '~' ? homedir() : decoded.startsWith('~/') ? join(homedir(), decoded.slice(2)) : decoded;
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function queueAttachment(session: HarnessSession, path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Attachments must be files.');
  if (info.size > 1024 * 1024) throw new Error('Attachments are limited to 1 MiB each.');
  session.attachments = [...new Set([...(session.attachments ?? []), path])].slice(-10);
}

async function prepareAttachments(paths: readonly string[]): Promise<{ textContext: string; images: string[] }> {
  const blocks: string[] = [];
  const images: string[] = [];
  let total = 0;
  for (const path of paths) {
    if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) { images.push(path); continue; }
    const info = await stat(path);
    if (info.size > 256 * 1024 || total + info.size > 512 * 1024) throw new Error('Text attachments are limited to 256 KiB each and 512 KiB per request.');
    const content = await readFile(path, 'utf8');
    total += Buffer.byteLength(content);
    blocks.push(`\n<clikcode_attachment path="${path.replace(/"/g, '&quot;')}">\n${content}\n</clikcode_attachment>`);
  }
  return { textContext: blocks.join('\n'), images };
}

function renderSessionCard(session: HarnessSession, account?: string): string {
  const modelLabel = nativeModelLabel(session.nativeHarness, session.model);
  return [
    chalk.bold.cyan('ClikCode'),
    ...(session.name ? [line('chat', session.name)] : []),
    line('project', compactPath(session.workspace ?? process.cwd())),
    line('provider', sessionProviderLabel(session)),
    line('account', account ?? 'default'),
    line('model', modelLabel ?? 'provider default'),
    line('effort', session.route === 'gateway' ? 'platform managed' : session.effort),
    line('permissions', session.route === 'gateway' ? 'platform policy' : session.permissionMode ?? 'ask'),
    line('session', session.id.slice(0, 8)),
  ].join('\n');
}

async function acquireRuntimeLock(lockPath: string, runtimePath: string): Promise<FileHandle> {
  const attempt = () => open(lockPath, 'wx', 0o600);
  try {
    return await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown };
      if (typeof runtime.pid === 'number') {
        process.kill(runtime.pid, 0);
        throw new Error(`a ${harnessCommand()} control API is already running (pid ${runtime.pid})`);
      }
    } catch (runtimeError) {
      if (runtimeError instanceof Error && runtimeError.message.includes('control API is already running')) throw runtimeError;
      if ((runtimeError as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`a ${harnessCommand()} control API appears to be running but its process cannot be inspected`);
      }
      // Missing/corrupt runtime metadata or ESRCH means the lock is stale.
    }
    await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    return attempt();
  }
}

/** Keep automation structured while making the foreground harness feel like a CLI, not an API dump. */
function emitHarnessOutput(payload: Record<string, unknown>): void {
  if (isJsonDefaultMode()) return emitJson(payload);
  if (activeFullScreenHarness) {
    // State-changing commands are reflected by the persistent status line. Raw
    // panels here would be written into the composer and corrupt the TUI.
    if (payload.panel === 'settings' && payload.session) {
      activeFullScreenHarness.render(
        payload.session as HarnessSession,
        typeof payload.account === 'string' ? payload.account : undefined,
      );
      return;
    }
    if (payload.panel === 'provider-selected' || (payload.panel === 'accounts' && payload.selected) || payload.status === 'connected') return;
  }
  if (payload.status === 'ready') {
    const session = payload.session as HarnessSession;
    const account = typeof payload.account === 'string' ? payload.account : undefined;
    output.write(`\n${renderSessionCard(session, account)}\n\n${chalk.dim('Type your request, /provider to choose a provider, or /help for commands.')}\n\n`);
    return;
  }
  if (payload.panel === 'provider-selected' && typeof payload.harness === 'string') {
    const account = typeof payload.account === 'string' ? ` · ${payload.account}` : '';
    output.write(`\n${chalk.green('✓')} ${chalk.bold(payload.harness)} selected${chalk.dim(account)}\n\n`);
    return;
  }
  if (payload.panel === 'error' && typeof payload.message === 'string') {
    output.write(`\n${chalk.red('Error:')} ${payload.message}\n\n`);
    return;
  }
  if (payload.panel === 'help') {
    output.write(`\n${chalk.bold('Commands')}\n\n` + [
      ['/<provider> [request]', 'handoff to a different provider and optionally send'],
      ['/provider', 'choose a provider or one of its accounts'],
      ['/new', 'start a clean conversation'],
      ['/resume', 'choose a saved session'],
      ['/status', 'show the current workspace and settings'],
      ['/model <name>', 'choose or view a model'],
      ['/effort <level>', 'set reasoning effort'],
      ['/permissions', 'choose approval behavior'],
      ['/sessions', 'list saved sessions'],
      ['/history', 'show this conversation'],
      ['/diff', 'show uncommitted project changes'],
      ['/review', 'ask the selected provider to review changes'],
      ['/init', 'create or improve repository agent instructions'],
      ['/copy', 'copy the last answer'],
      ['/mention', 'attach a file to the next request'],
      ['/rename', 'name this conversation'],
      ['/fork', 'branch this conversation'],
      ['/archive', 'archive this conversation'],
      ['/delete', 'delete this conversation'],
      ['/clear', 'clear the screen'],
      ['/exit', 'close ClikCode'],
    ].map(([command, description]) => `  ${chalk.cyan(command.padEnd(24))}${description}`).join('\n') + '\n\n');
    return;
  }
  if (payload.panel === 'settings' && payload.session) {
    const session = payload.session as HarnessSession;
    const account = typeof payload.account === 'string' ? payload.account : undefined;
    output.write(`\n${chalk.bold('Current setup')}\n${renderSessionCard(session, account)}\n\n${chalk.dim('Change with /model, /effort, /provider, or /switch.')}\n\n`);
    return;
  }
  if (payload.panel === 'accounts' && Array.isArray(payload.accounts)) {
    const accounts = payload.accounts as Array<Record<string, unknown>>;
    output.write(`\n${chalk.bold('Accounts')}\n` + (accounts.length ? accounts.map((account) => {
      const selected = (payload.session as HarnessSession | undefined)?.accountId === account.id;
      return `  ${selected ? chalk.green('●') : chalk.dim('○')} ${account.label} ${chalk.dim(`(${account.provider} · ${account.status})`)}`;
    }).join('\n') : `  ${chalk.dim('No accounts yet.')}`) + `\n\n${chalk.dim('Use /account to choose, or /accounts login <provider> <label>.')}\n\n`);
    return;
  }
  if (payload.panel === 'accounts' && payload.selected && typeof payload.selected === 'object') {
    const selected = payload.selected as Record<string, unknown>;
    output.write(`\n${chalk.green('✓')} Account selected: ${chalk.bold(String(selected.label))} ${chalk.dim(`(${selected.provider})`)}\n\n`);
    return;
  }
  if (payload.panel === 'models' && Array.isArray(payload.models)) {
    const models = payload.models as Array<Record<string, unknown>>;
    output.write(`\n${chalk.bold('Models')}\n` + (models.length ? models.map((model) => `  ${model.model} ${chalk.dim(`(${model.provider ?? model.account})`)}`).join('\n') : `  ${chalk.dim('Using the provider default. Set one with /model <name>.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'sessions' && Array.isArray(payload.sessions)) {
    const sessions = payload.sessions as Array<Record<string, unknown>>;
    output.write(`\n${chalk.bold('Sessions')}\n` + (sessions.length ? sessions.map((item) => `  ${String(item.id).slice(0, 8)}  ${item.harness ?? item.provider ?? 'unselected'}  ${chalk.dim(String(item.status))}`).join('\n') : `  ${chalk.dim('No saved sessions.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'conversation-reset') {
    output.write(`\n${chalk.green('✓')} New conversation started\n\n`);
    return;
  }
  if (payload.panel === 'history' && Array.isArray(payload.messages)) {
    const messages = payload.messages as Array<{ role: string; content: string }>;
    output.write(`\n${chalk.bold('Conversation')}\n\n` + (messages.length
      ? messages.map((message) => `${message.role === 'assistant' ? chalk.cyan('assistant') : chalk.green('you')}\n${message.content}`).join('\n\n')
      : chalk.dim('No messages yet.')) + '\n\n');
    return;
  }
  if (payload.panel === 'diff' && typeof payload.diff === 'string') {
    output.write(`\n${chalk.bold('Project changes')}\n\n${payload.diff || chalk.dim('Working tree is clean.')}\n\n`);
    return;
  }
  if (payload.panel === 'attachments' && Array.isArray(payload.attachments)) {
    const attachments = payload.attachments as string[];
    output.write(`\n${chalk.bold('Next-request attachments')}\n` + (attachments.length
      ? attachments.map((path) => `  ${chalk.cyan('•')} ${compactPath(path)}`).join('\n')
      : `  ${chalk.dim('None queued.')}`) + '\n\n');
    return;
  }
  if (payload.panel === 'usage' && payload.totals && typeof payload.totals === 'object') {
    const totals = payload.totals as Record<string, unknown>;
    output.write(`\n${chalk.bold('Usage')}\n${line('calls', totals.calls)}\n${line('input', `${totals.inputTokens ?? 0} tokens`)}\n${line('output', `${totals.outputTokens ?? 0} tokens`)}\n\n`);
    return;
  }
  if (payload.panel === 'session-closed') {
    output.write(`\n${chalk.dim('Session saved. See you next time.')}\n\n`);
    return;
  }
  if (typeof payload.text === 'string') {
    output.write(`\n${payload.text}\n\n`);
    return;
  }
  if (typeof payload.panel === 'string') {
    const controls = Array.isArray(payload.controls) ? payload.controls.join(' · ') : '';
    const title = payload.panel.replace(/-/g, ' ').replace(/^./, (value) => value.toUpperCase());
    output.write(`\n${chalk.bold(title)}${controls ? `\n  ${chalk.dim(controls)}` : ''}\n\n`);
    return;
  }
  emitJson(payload);
}
setEmitHarnessOutput(emitHarnessOutput);

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function methodAndPath(request: IncomingMessage): `${string} ${string}` {
  return `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice('Bearer '.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

function localApiKey(account: AiHarnessAccount): string {
  if (account.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) {
    throw new Error('this account needs a supported local API-key resolver (env:NAME)');
  }
  const name = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid local environment credential reference');
  const value = process.env[name];
  if (!value) throw new Error(`local credential ${name} is not available in this harness process`);
  return value;
}


/** Starts an intentionally loopback-only harness service. It exposes no provider tokens. */
export async function aiStart(_config: Conf, options: { port?: string }): Promise<void> {
  // The control API is optional. When no port is requested, defer entirely to
  // the OS so ClikCode never competes with ClikDeploy or another local tool.
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const runtimeDirectory = join(harnessStatePath(), '..');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimePath = join(runtimeDirectory, 'runtime.json');
  const lockPath = join(runtimeDirectory, 'runtime.lock');
  const runtimeLock = await acquireRuntimeLock(lockPath, runtimePath);
  const startupState = await readState();
  const server = createServer(async (request, response) => {
    try {
      const route = methodAndPath(request);
      if (route === 'GET /v1/health') {
        sendJson(response, 200, { status: 'ok', installationId: startupState.installationId, runtime: harnessCommand(), credentialBoundary: 'local-only' });
      } else if (!authorized(request, startupState.localApiToken)) {
        sendJson(response, 401, { error: 'unauthorized' });
      } else {
        // Commands and native harnesses may update state while the optional
        // control API is running. Always serve the latest atomic snapshot.
        const state = await readState();
        if (route === 'GET /v1/accounts') {
        sendJson(response, 200, { accounts: state.accounts.map(accountView) });
        } else if (route === 'GET /v1/device') {
        sendJson(response, 200, { device: deviceManifest(state) });
        } else if (route === 'GET /v1/models') {
        sendJson(response, 200, {
          models: state.accounts.flatMap((account) => account.models.map((model) => ({ accountId: account.id, provider: account.provider, model }))),
        });
        } else if (route === 'GET /v1/sessions') {
        sendJson(response, 200, { sessions: state.sessions });
        } else if (route === 'GET /v1/usage') {
        sendJson(response, 200, { invocations: state.invocations });
        } else if (route === 'POST /v1/chat') {
        const body = await readJson(request) as { accountId?: unknown; messages?: unknown; effort?: unknown };
        const account = state.accounts.find((item) => item.id === body.accountId);
        if (!account) throw new Error('local account not found');
        if (!Array.isArray(body.messages) || !body.messages.every((m) => typeof m === 'object' && m !== null && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string')) {
          throw new Error('messages must be user/assistant text messages');
        }
        const model = account.models[0];
        if (!model) throw new Error('local account has no configured model');
        const startedAt = Date.now();
        const turn = await streamLocalAiTurn({ provider: account.provider, model, apiKey: localApiKey(account), credentialSource: 'env', messages: body.messages as Array<{ role: 'user' | 'assistant'; content: string }>, ...(typeof body.effort === 'string' ? { reasoningEffort: body.effort as never } : {}) });
        const invocation = { id: randomUUID(), accountId: account.id, provider: account.provider, model, at: new Date().toISOString(), inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt };
        state.invocations.push(invocation);
        await writeState(state);
        sendJson(response, 200, { text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation });
        } else {
          sendJson(response, 404, { error: 'not_found' });
        }
      }
    } catch {
      sendJson(response, 500, { error: 'harness_error' });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local control API did not expose a TCP address');
    await writeFile(runtimePath, `${JSON.stringify({ pid: process.pid, port: address.port, host: '127.0.0.1', installationId: startupState.installationId, startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    emitJson({ status: 'running', url: `http://127.0.0.1:${address.port}`, installationId: startupState.installationId, credentialBoundary: 'local-only' });
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await runtimeLock.close().catch(() => undefined);
    await unlink(runtimePath).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function aiStatus(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown; port?: unknown; host?: unknown; installationId?: unknown; startedAt?: unknown };
    let running = false;
    if (typeof runtime.pid === 'number') {
      try { process.kill(runtime.pid, 0); running = true; } catch (error) { running = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    emitJson({ status: running ? 'running' : 'stale', ...runtime, credentialBoundary: 'local-only' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    emitJson({ status: 'stopped' });
  }
}

export async function aiStop(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  const state = await readState();
  let runtime: { pid?: unknown; installationId?: unknown };
  try {
    runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as typeof runtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emitJson({ status: 'stopped' });
    throw error;
  }
  if (runtime.installationId !== state.installationId || typeof runtime.pid !== 'number') {
    throw new Error('refusing to stop a runtime record that does not belong to this ClikCode installation');
  }
  try { process.kill(runtime.pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  emitJson({ status: 'stopping', pid: runtime.pid });
}

/** Select a provider while retaining ClikCode as the foreground UI. Installs
 * it first if needed, and — only inside the interactive full-screen session,
 * where suspending the alt-screen for a vendor login prompt makes sense —
 * signs in if the vendor CLI reports (or a fresh install implies) that it
 * isn't authenticated yet. The goal: every harness either works immediately
 * or ClikCode gets you to "working" itself, instead of erroring and telling
 * you to go run something separately. */
export async function aiHarnessSelect(harnessCommandName: string, sessionId: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (harness.surface !== 'terminal') throw new Error(`${harness.displayName} is editor-only and cannot run turns inside ClikCode.`);
  if (!harness.turn) throw new Error(`${harness.displayName} does not publish a non-interactive CLI contract required by the centralized ClikCode UI.`);
  const freshInstall = !(await inspectNativeHarness(harness)).installed;
  if (freshInstall) {
    activeFullScreenHarness?.startWaiting(`installing ${harness.displayName}…`);
    try { await ensureNativeHarness(harness); } finally { activeFullScreenHarness?.stopWaiting(); }
  }
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const sameHarness = session.nativeHarness === harness.command;
  if (!sameHarness) {
    if (requiresProviderHandoff(session, harness.command)) {
      throw new Error(`Use /${harness.command} to hand off this ${sessionProviderLabel(session)} conversation. Native provider changes always create a new branch.`);
    }
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.model = null;
  }
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.route = 'local';
  session.workspace ??= process.cwd();
  const selected = session.accountId ? state.accounts.find((account) => account.id === session.accountId) : undefined;
  // Tracks whether the account below is being minted right now, not found
  // pre-existing -- needed because harnessNeedsLogin returns false
  // unconditionally for any harness with no statusArgv (Gemini, Antigravity,
  // Amp: nothing to scriptably ask "are you logged in?" at all), so a
  // brand-new placeholder account for one of those would otherwise be
  // marked 'ready' and never get a single chance at the login/suspend
  // handoff -- the real mechanism behind "Antigravity CLI does not publish
  // an isolated configuration-root contract" surfacing at /add-account
  // time instead: the placeholder had already silently claimed the one
  // available account slot for a harness with no profileEnv, with the user
  // never having had a real opportunity to authenticate it in the first
  // place.
  let accountJustCreated = false;
  if (!selected || selected.provider !== harness.provider || selected.status !== 'ready') {
    const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.authKind === 'vendor-cli' && account.status === 'ready');
    if (accounts.length === 1) session.accountId = accounts[0].id;
    else if (accounts.length === 0) {
      accountJustCreated = true;
      // Same derivation addAccountForHarness uses after an explicit login,
      // applied here too so a session's very first auto-created account
      // shows a real identity from the start instead of the generic "X
      // default" placeholder this used unconditionally before -- which is
      // exactly what was confusing about accounts named "Claude Code
      // default"/"Codex default" etc. undefined profilePath is correct
      // here: this is always the harness's one default, unisolated profile,
      // never one under an isolated CLAUDE_CONFIG_DIR-style directory.
      // Falls back to the placeholder if derivation finds nothing (most
      // harnesses currently), AND if the derived label would collide with
      // an account that already exists under a different provider (the
      // same real person's email showing up on two harnesses is entirely
      // possible and not a bug) -- labels must stay globally unique, and
      // the safe "X default" naming always is, by construction.
      const derived = await deriveAccountLabel(harness, undefined);
      const label = derived && !state.accounts.some((item) => item.label.toLowerCase() === derived.toLowerCase())
        ? derived : `${harness.displayName} default`;
      const account: AiHarnessAccount = {
        id: randomUUID(), provider: harness.provider, label, authKind: 'vendor-cli',
        models: [], status: 'ready', credentialRef: `native:${harness.binary}:default`,
      };
      state.accounts.push(account);
      session.accountId = account.id;
    } else session.accountId = null;
  }
  let account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (activeFullScreenHarness && harness.loginArgv) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    if (freshInstall || (accountJustCreated && !harness.statusArgv) || await harnessNeedsLogin(harness, environment)) {
      if (harness.loginCapturable) {
        activeFullScreenHarness.startWaiting(`signing in to ${harness.displayName}…`);
        try { await loginNativeHarness(harness, environment); } finally { activeFullScreenHarness.stopWaiting(); }
      } else {
        activeFullScreenHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
        await activeFullScreenHarness.suspend();
        try {
          announceBareInteractiveLogin(harness);
          await loginNativeHarness(harness, environment);
        } finally {
          activeFullScreenHarness.resume();
        }
      }
      // Same identity check /account's "add another account" flow uses --
      // a plain /provider login deserves the real dedup-by-identity logic,
      // not a weaker "only rename if it still looks like a placeholder"
      // check that misses re-authenticating as a genuinely different real
      // account entirely.
      if (account) {
        account = await syncAccountIdentityAfterLogin(harness, account, state);
        session.accountId = account.id;
      }
    }
  }
  if (!session.model) {
    const catalog = await nativeModelCatalog(harness, account);
    if (catalog.configured) session.model = catalog.configured;
  }
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  const compatible = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  emitHarnessOutput({
    panel: 'provider-selected', harness: harness.command, displayName: harness.displayName, provider: harness.provider,
    account: state.accounts.find((account) => account.id === session.accountId)?.label ?? null,
    model: session.model ?? 'provider default', centralized: true,
    ...(session.accountId ? {} : { actionRequired: `Choose one with /accounts use <label>`, accounts: compatible.map(accountView) }),
  });
}

export async function aiModelsList(): Promise<void> {
  const state = await readState();
  emitJson({
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id,
      account: account.label,
      provider: account.provider,
      model,
      status: account.status,
    }))),
  });
}

export async function aiUsage(): Promise<void> {
  const state = await readState();
  const totals = state.invocations.reduce(
    (sum, invocation) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: sum.latencyMs + invocation.latencyMs,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  );
  emitJson({ ...totals, avgLatencyMs: totals.calls ? Math.round(totals.latencyMs / totals.calls) : 0, invocations: state.invocations });
}

/** Reports the separate ClikDeploy OAuth/API-key gateway identity, never a BYO provider login. */
export async function aiGatewayStatus(config: Conf): Promise<void> {
  const apiUrl = ApiClient.getApiUrl(config);
  emitJson({
    route: 'gateway',
    connected: Boolean(ApiClient.getApiKeyForUrl(config, apiUrl)),
    apiUrl,
    authentication: 'clikdeploy-oauth-or-api-key',
    credentialBoundary: 'gateway-auth-only',
    hint: `Run \`${harnessCommand()} gateway login\` to connect ClikDeploy Gateway, or use \`${harnessCommand()} accounts add\` for a provider login that stays local.`,
  });
}

const VALID_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const VALID_PERMISSION_MODES: readonly AiHarnessPermissionMode[] = ['ask', 'bypass', 'auto'];

function optionForHarness(harness: AiLocalHarnessDefinition, id: string): AiHarnessOptionDefinition | undefined {
  return localHarnessCapabilityManifest(harness).options.find((option) => option.id === id);
}

function parseHarnessOption(option: AiHarnessOptionDefinition, raw: string): unknown {
  const value = raw.trim();
  if (option.kind === 'boolean') {
    if (['true', 'on', 'yes', '1', 'enabled'].includes(value.toLowerCase())) return true;
    if (['false', 'off', 'no', '0', 'disabled'].includes(value.toLowerCase())) return false;
    throw new Error(`${option.label} must be on or off`);
  }
  if (option.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option.label} must be a non-negative number`);
    return parsed;
  }
  if (option.kind === 'string-list' || option.kind === 'path-list') {
    const values = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${option.label} requires at least one value`);
    return values;
  }
  if (option.values?.length && !option.values.includes(value)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
  if (!value) throw new Error(`${option.label} cannot be empty`);
  return value;
}

function setSessionHarnessOption(session: HarnessSession, harness: AiLocalHarnessDefinition, id: string, raw: string): void {
  const option = optionForHarness(harness, id);
  if (!option) throw new Error(`${harness.displayName} does not support option "${id}"`);
  const parsed = parseHarnessOption(option, raw);
  if (id === 'model') session.model = String(parsed);
  else if (id === 'effort') session.effort = String(parsed);
  else if (id === 'workspace') session.workspace = String(parsed);
  else if (id === 'permissions') session.permissionMode = String(parsed) as AiHarnessPermissionMode;
  else session.harnessOptions = { ...(session.harnessOptions ?? {}), [id]: parsed };
  if (option.requiresNewSession) {
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
  }
}

function normalizeFailoverWord(value: string): 'never' | 'on-quota-exhausted' {
  if (value === 'auto') return 'on-quota-exhausted';
  if (value === 'never') return 'never';
  throw new Error('failover must be auto or never');
}

/** Both `/settings global <key> <value>` and `/settings provider <id> <key> <value>`
 * write into the same three fields; this is the one place that validates a value
 * for a given key so the two entry points can't drift out of sync.
 *
 * `harness`, when given (the provider-scoped path only — a global default has
 * no single harness to check against), gates effort and permission mode on
 * what the catalog actually declares that vendor CLI supports. Without this,
 * a provider override could be accepted and then silently do nothing: the
 * turn-argv builder already only applies effort when `effortArgvPrefix` is
 * declared, and only applies permission mode when the harness's declared
 * `permissionModes` includes it. */
function applyDefaultSetting(target: Partial<HarnessDefaultSettings & { model: string }>, key: string, value: string, harness?: AiLocalHarnessDefinition): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'effort') {
    if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.`);
    if (!VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) throw new Error(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
    target.effort = value;
  } else if (normalizedKey === 'permissions' || normalizedKey === 'permissionmode') {
    if (!VALID_PERMISSION_MODES.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
    if (harness && !harnessSupportsPermissionMode(harness, value as AiHarnessPermissionMode)) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag; setting one here would silently do nothing.`);
    target.permissionMode = value as AiHarnessPermissionMode;
  } else if (normalizedKey === 'failover') {
    target.accountFailover = normalizeFailoverWord(value);
  } else if (normalizedKey === 'model' && 'model' in target) {
    target.model = value === 'auto' || value === 'default' ? undefined : value;
  } else {
    throw new Error(`unknown setting "${key}"; choose ${'model' in target ? 'model, ' : ''}effort, permissions, or failover`);
  }
}

/** Read-only view of the defaults every new chat is built from. */
export async function aiSettingsShow(): Promise<void> {
  const state = await readState();
  emitJson({ globalSettings: state.globalSettings, providerSettings: state.providerSettings });
}

/** Applies to every provider that doesn't have its own override. */
export async function aiSettingsSetGlobal(key: string, value: string): Promise<void> {
  const state = await readState();
  applyDefaultSetting(state.globalSettings, key, value);
  await writeState(state);
  emitJson({ globalSettings: state.globalSettings });
}

/** Overrides the global default for one provider only; existing sessions are untouched. */
export async function aiSettingsSetProvider(providerOrHarness: string, key: string, value: string): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  const entry: Partial<HarnessDefaultSettings & { model: string }> = { ...state.providerSettings[harness.provider] };
  applyDefaultSetting(entry, key, value, harness);
  state.providerSettings[harness.provider] = entry;
  await writeState(state);
  emitJson({ provider: harness.provider, settings: entry });
}

/** Removes every override for one provider, falling back to the global defaults. */
export async function aiSettingsClearProvider(providerOrHarness: string): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  delete state.providerSettings[harness.provider];
  await writeState(state);
  emitJson({ provider: harness.provider, settings: {} });
}

export async function aiSessionCreate(options: { route: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  if (options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.route === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover)) {
    throw new Error('Gateway account, provider, model, effort, and failover are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  const state = await readState();
  const account = options.account
    ? state.accounts.find((item) => item.id === options.account || item.label === options.account)
    : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
  const provider = options.provider ?? account?.provider ?? null;
  const harness = provider ? localHarnessForProvider(provider) : undefined;
  if (provider && !harness && options.route === 'local') throw new Error(`unknown local provider "${provider}"`);
  if (options.model && harness && !harness.modelArgvPrefix) throw new Error(`${harness.displayName} does not publish a model selector.`);
  if (options.effort && harness) {
    const effortOption = optionForHarness(harness, 'effort');
    if (!effortOption) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  const defaults = resolveDefaultSettings(state, provider);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: id, route: options.route, accountId: options.route === 'gateway' ? null : account?.id ?? null,
    provider: options.route === 'gateway' ? 'clikdeploy-gateway' : provider,
    model: options.route === 'gateway' ? null : options.model ?? (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
    effort: options.route === 'gateway' ? 'platform-managed' : options.effort ?? defaults.effort,
    ...(options.route === 'local' ? { permissionMode: defaults.permissionMode } : {}),
    accountFailover: options.route === 'gateway' ? 'never' : options.accountFailover ?? defaults.accountFailover,
    ...(options.route === 'gateway' ? { gatewayConfirmed: true as const } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  emitJson({ session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  emitJson({ sessions: state.sessions });
}

/** Edit the active conversation's approval behavior from the top-level
 * `clikcode permissions` command. The same picker and provider capability
 * checks back the in-chat `/permissions` command, so the two surfaces cannot
 * drift. With no conversation yet, a selection becomes the global default. */
export async function aiPermissions(mode?: string): Promise<void> {
  const normalizedMode = mode?.trim().toLowerCase() as AiHarnessPermissionMode | undefined;
  if (normalizedMode && !VALID_PERMISSION_MODES.includes(normalizedMode)) {
    throw new Error('permissions must be ask, bypass, or auto');
  }
  const state = await readState();
  const session = [...state.sessions]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt.localeCompare(left.updatedAt))[0];
  if (normalizedMode) {
    if (session) await aiSessionCommand(session.id, `/permissions ${normalizedMode}`);
    else await aiSettingsSetGlobal('permissions', normalizedMode);
    return;
  }
  if (!input.isTTY || !output.isTTY) throw new Error('interactive input is required; use `clikcode permissions ask|bypass|auto`');
  const rl = new FullScreenHarnessPrompter();
  activeFullScreenHarness = rl;
  try {
    if (session) {
      const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
      rl.render?.(session, account);
      await interactivePermissionPicker(rl, session.id);
    } else {
      const selected = await chooseOption(rl, 'Choose permissions', VALID_PERMISSION_MODES.map((value) => ({
        label: value[0].toUpperCase() + value.slice(1), value,
      })));
      if (selected) await aiSettingsSetGlobal('permissions', selected);
    }
  } finally {
    activeFullScreenHarness = undefined;
    rl.close();
  }
}

/**
 * The standalone `clikcode` command is a coding-session entrypoint, not a
 * command browser. Resume the most recently used session, creating the first
 * local session on demand so a fresh install lands directly in the TTY.
 */
export async function aiSessionOpenDefault(config: Conf): Promise<void> {
  const state = await readState();
  let session = defaultSessionCandidate(state.sessions);
  // Releases before /exit was separated from session-close could leave the
  // real provider branch closed, then create a second unstarted handoff from
  // its older parent on the next launch. Recover only that unambiguous shape:
  // same conversation/provider, no native identity on the selected shell,
  // and a bound branch containing strictly more history.
  if (session?.parentSessionId && session.nativeHarness && !session.nativeSessionId) {
    const established = establishedProviderBranch(state.sessions, session, session.nativeHarness);
    if (established && (established.messages?.length ?? 0) > (session.messages?.length ?? 0)) {
      const now = new Date().toISOString();
      session.status = 'closed';
      session.closedAt = now;
      session.updatedAt = now;
      markSessionLeftOpen(established, now);
      session = established;
      await writeState(state);
    }
  }
  if (!session) {
    // A closed chat must never reopen without an explicit `sessions open`.
    // Its configuration is still the user's last agent choice, so carry that
    // forward into a clean chat rather than guessing a provider or model.
    const previous = [...state.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const provider = previous?.provider ?? null;
    const defaults = resolveDefaultSettings(state, provider);
    const now = new Date().toISOString();
    const route = previous?.route ?? 'local';
    const id = randomUUID();
    session = {
      id, conversationId: id, route, accountId: route === 'gateway' ? null : previous?.accountId ?? null,
      provider: route === 'gateway' ? 'clikdeploy-gateway' : provider,
      model: route === 'gateway' ? null : (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
      effort: route === 'gateway' ? 'platform-managed' : defaults.effort,
      accountFailover: route === 'gateway' ? 'never' : defaults.accountFailover,
      ...(route === 'local' ? { permissionMode: defaults.permissionMode } : {}),
      createdAt: now, updatedAt: now, status: 'active',
    };
    state.sessions.push(session);
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
}

export async function aiSessionShow(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  emitJson({ session });
}

export async function aiSessionResume(config: Conf, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
  }
  await aiSessionInteractive(config, session.id);
}

/** Close is centralized even when the selected native agent has already exited. */
export async function aiSessionClose(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // A session that never received a single turn AND was never linked to a
  // real vendor conversation has nothing to resume — keeping it as "closed"
  // clutter buries real conversations under identical "Untitled chat" entries
  // every time the app is opened and exited without typing anything. Drop it
  // outright instead of accumulating it. A set nativeSessionId is kept even
  // with zero ClikCode-tracked messages: it may be adopted from, or linked
  // directly to, a vendor's own conversation that has real content ClikCode
  // just never routed a turn through. A session with nativeHarness set is
  // kept too, even message-less: explicitly choosing a native provider and
  // configuring its account is real, deliberate setup work, not an
  // accidental blank launch. nativeHarness is the reliable signal here
  // specifically because it is ONLY ever set by an explicit selection
  // (aiHarnessSelect, newProviderConversation) -- unlike `provider`,
  // `accountId`, and `route`, which aiSessionOpenDefault's own "create a
  // fresh default session" path silently carries forward from whatever
  // session came before, even when the user has configured nothing yet.
  // gatewayConfirmed is the same signal for the one route (Gateway) that
  // doesn't otherwise have a reliable "was this deliberate" field to check.
  if (!(session.messages ?? []).length && !session.nativeSessionId && !session.nativeHarness && !session.gatewayConfirmed) {
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
  }
  if (session.status !== 'closed') {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
  }
  emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
}

/** Save-and-leave lifecycle used by /exit. This deliberately does not call
 * aiSessionClose: closing a terminal must not make startup fall back to an
 * older provider branch of the same conversation. */
async function aiSessionLeave(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  markSessionLeftOpen(session, new Date().toISOString());
  await writeState(state);
}

/** Shared slash-command grammar for a future TTY client and the headless CLI. */
export async function aiSessionCommand(id: string, input: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const words = input.trim().replace(/^\//, '').split(/\s+/).filter(Boolean);
  const head = words.shift()?.toLowerCase();
  if (!head) throw new Error('slash command is required');
  if (head === 'help') {
    return emitHarnessOutput({
      panel: 'help',
      controls: [
        '/settings', '/settings route|account|model|effort <value>',
        '/settings global effort|permissions|failover <value>', '/settings provider <id> model|effort|permissions|failover <value>|clear',
        '/account', '/model', '/sessions', '/usage', '/<harness>', '/exit',
      ],
    });
  }
  if (head === 'status') {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    return emitHarnessOutput({ panel: 'settings', session, account });
  }
  if (head === 'new' || head === 'reset') {
    session.messages = [];
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'conversation-reset', session });
  }
  if (head === 'permissions') {
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
  }
  if (head === 'history') return emitHarnessOutput({ panel: 'history', messages: session.messages ?? [] });
  if (head === 'copy') {
    const last = [...(session.messages ?? [])].reverse().find((message) => message.role === 'assistant');
    if (!last) throw new Error('There is no assistant response to copy yet.');
    await copyToClipboard(last.content);
    return emitHarnessOutput({ panel: 'copied', text: 'Last response copied to the clipboard.' });
  }
  if (head === 'mention' || head === 'attachments') {
    const action = words.join(' ').trim();
    if (!action) return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
    if (action === 'clear') {
      session.attachments = [];
    } else {
      const unquoted = decodeAttachmentPath(action);
      const workspace = session.workspace ?? process.cwd();
      const expanded = unquoted === '~' ? homedir() : unquoted.startsWith('~/') ? join(homedir(), unquoted.slice(2)) : unquoted;
      const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
      await queueAttachment(session, path);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
  }
  if (head === 'diff') {
    const workspace = session.workspace ?? process.cwd();
    const diff = await captureProcess('git', ['diff', '--no-ext-diff', '--stat', '--', '.'], workspace);
    const details = await captureProcess('git', ['diff', '--no-ext-diff', '--', '.'], workspace);
    const combined = `${diff.trim()}${diff.trim() && details.trim() ? '\n\n' : ''}${details.trim()}`;
    return emitHarnessOutput({ panel: 'diff', diff: combined.slice(0, 512 * 1024) });
  }
  if (head === 'review' || head === 'init') {
    if (session.route === 'gateway') throw new Error(`/${head} is available in the interactive ClikCode session for Gateway routes.`);
    const extra = words.join(' ').trim();
    const prompt = head === 'review'
      ? `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`
      : 'Inspect this repository and create or improve AGENTS.md with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.';
    return aiSessionSend(id, prompt);
  }
  if (head === 'rename') {
    const name = words.join(' ').trim();
    if (!name) throw new Error('Enter a name after /rename.');
    session.name = name.slice(0, 120);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-renamed', text: `Conversation renamed to “${session.name}”.` });
  }
  if (head === 'archive') {
    session.status = 'archived';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
  }
  if (head === 'delete') {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  }
  if (head === 'fork') {
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id,
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A fork is a sibling concept, not another copy of the handoff event that
    // created its parent. Its parentSessionId is sufficient ancestry.
    delete fork.handoff;
    state.sessions.push(fork);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-forked', text: `Conversation forked as ${fork.id.slice(0, 8)}. Use /resume to open it.`, session: fork });
  }
  if (head === 'model') {
    const value = words.join(' ').trim();
    if (!value) throw new Error('Choose a model from /model or use /model <name>.');
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    session.model = value === 'default' || value === 'auto' ? null : value;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  }
  if (head === 'effort') {
    const value = words.join(' ').trim().toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    setSessionHarnessOption(session, harness, 'effort', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  }
  if (head === 'account' && words.length) {
    return aiSessionCommand(id, `/accounts use ${words.join(' ')}`);
  }
  if (head === 'sessions') {
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
  }
  if (head === 'models') {
    return emitHarnessOutput({
      panel: 'models',
      models: state.accounts.flatMap((account) => account.models.map((model) => ({ account: account.label, provider: account.provider, model }))),
      selected: session.model,
    });
  }
  if (head === 'usage') {
    const invocations = state.invocations.filter((invocation) => invocation.accountId === session.accountId || (session.route === 'gateway' && invocation.accountId === 'gateway'));
    return emitHarnessOutput({
      panel: 'usage', invocations,
      totals: invocations.reduce((total, invocation) => ({ calls: total.calls + 1, inputTokens: total.inputTokens + (invocation.inputTokens ?? 0), outputTokens: total.outputTokens + (invocation.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, outputTokens: 0 }),
    });
  }
  if (head === 'settings') {
    const setting = words.shift()?.toLowerCase();
    const value = words.join(' ').trim();
    if (!setting) return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
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
      if (accountHarness?.turn && session.nativeHarness !== accountHarness.command) {
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
  }
  if (head === 'accounts') {
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
      if (accountHarness?.turn && session.nativeHarness !== accountHarness.command) {
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
  }
  if (head === 'gateway') {
    if ((session.messages ?? []).length || session.nativeSessionId) {
      throw new Error('Use the interactive /provider menu to hand off an existing conversation to ClikDeploy Gateway.');
    }
    applyGatewaySessionPolicy(session);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'clikdeploy-gateway', account: null, model: 'platform', centralized: true });
  }
  const harness = localHarnessForCommand(head);
  if (harness) {
    const targetId = requiresProviderHandoff(session, harness.command)
      ? await newProviderConversation(id, harness.command)
      : id;
    if (targetId === id) await aiHarnessSelect(harness.command, targetId);
    const firstPrompt = words.join(' ').trim();
    if (firstPrompt) await aiSessionSend(targetId, firstPrompt);
    return;
  }
  throw new Error(`unknown slash command: /${head}`);
}

/** actions is deliberately narrow -- a plain label/value pair, not a full
 * nested PickerOption -- since it's rendered by select()'s own generic
 * right-arrow handler for *any* picker, not something built per-caller.
 * A caller (e.g. the account picker) that wants "disconnect"/"reauthenticate"
 * attaches them here; select() has no idea what they mean, it just shows
 * them and returns whichever one was chosen. */

async function chooseOption<T>(rl: HarnessPrompter, title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  if (rl.select) return rl.select(title, options, onAction);
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

async function newProviderConversation(currentId: string, harnessCommandName: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (current.route === 'local' && current.nativeHarness === harness.command) return current.id;
  // Refresh the source before freezing its portable ClikCode history into a
  // child branch. The source native session remains untouched after this.
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  const defaults = resolveDefaultSettings(state, harness.provider);
  const now = new Date().toISOString();
  const sourceDisplayName = current.nativeHarness
    ? localHarnessForCommand(current.nativeHarness)?.displayName
    : sessionProviderLabel(current);
  const session = createHandoffBranch({
    source: current, target: harness, accountId: accounts.length === 1 ? accounts[0]!.id : null,
    model: state.providerSettings[harness.provider]?.model ?? null, defaults, now, sourceDisplayName,
  });
  state.sessions.push(session);
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, session.id);
  return session.id;
}

async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter): Promise<void> {
  const apiUrl = ApiClient.getApiUrl(config);
  if (ApiClient.getApiKeyForUrl(config, apiUrl)) return;
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
  ]);
  if (!provider) throw new Error('ClikDeploy Gateway sign-in was cancelled.');
  if (rl instanceof FullScreenHarnessPrompter) await rl.suspend();
  try {
    await login(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof FullScreenHarnessPrompter) rl.resume();
  }
  if (!ApiClient.getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a Gateway credential.');
}

async function newGatewayConversation(config: Conf, rl: HarnessPrompter, currentId: string): Promise<string> {
  await ensureGatewayLogin(config, rl);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  if (current.route === 'gateway') return current.id;
  if (!hasConversationContent(current) && !current.nativeHarness) {
    applyGatewaySessionPolicy(current);
    current.updatedAt = new Date().toISOString();
    await writeState(state);
    return current.id;
  }
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const now = new Date().toISOString();
  const id = randomUUID();
  const sourceHarness = current.nativeHarness ? localHarnessForCommand(current.nativeHarness) : undefined;
  const sourceLabel = sourceHarness?.displayName ?? sessionProviderLabel(current);
  const session: HarnessSession = {
    id, conversationId: conversationIdFor(current), parentSessionId: current.id,
    handoff: { fromSessionId: current.id, fromHarness: current.nativeHarness ?? current.route, at: now },
    route: 'gateway', accountId: null, provider: 'clikdeploy-gateway', model: null,
    effort: 'platform-managed', accountFailover: 'never',
    workspace: current.workspace ?? process.cwd(), name: current.name ? `${current.name.replace(/\s+\(from [^)]+\)$/i, '')} (from ${sourceLabel})` : undefined,
    ...(current.messages?.length ? { messages: current.messages.map((message) => ({ ...message })) } : {}),
    createdAt: now, updatedAt: now, status: 'active',
    gatewayConfirmed: true,
  };
  state.sessions.push(session);
  await writeState(state);
  return session.id;
}

export type ProviderChoice =
  | { kind: 'gateway' }
  | { kind: 'provider'; harness: string };

export type ProviderAccountChoice =
  | { kind: 'account'; harness: string; accountId: string }
  | { kind: 'add-account'; harness: string };

/** Keep the first level deliberately sparse. Choosing a provider opens its
 * account list instead of mixing every account from every vendor together. */
export function providerPickerOptions(
  available: ReadonlyArray<{ harness: AiLocalHarnessDefinition; inspection: { installed: boolean; version?: string } }>,
  session: HarnessSession,
  gatewayConnected: boolean,
): PickerOption<ProviderChoice>[] {
  return [{
    label: 'ClikDeploy Gateway',
    detail: `· ${gatewayConnected ? 'connected' : 'sign in with OAuth'}${session.route === 'gateway' ? ' · current' : ''}`,
    value: { kind: 'gateway' },
  }, ...available.map(({ harness, inspection }) => ({
      label: harness.displayName,
      detail: `${inspection.installed
        ? `· installed${inspection.version ? ` ${inspection.version}` : ''}`
        : harness.npmPackage ? '· install when needed' : '· vendor install required'}${session.route === 'local' && session.nativeHarness === harness.command ? ' · current' : ''}`,
      value: { kind: 'provider' as const, harness: harness.command },
    })),
  ];
}

/** Account usage is loaded only after its provider is opened, avoiding a
 * wall of rows and avoiding quota probes for providers the user never views. */
export function providerAccountPickerOptions(
  harness: AiLocalHarnessDefinition,
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string }>,
  session: HarnessSession,
): PickerOption<ProviderAccountChoice>[] {
  return [
    ...[...accounts].sort((left, right) => left.account.label.localeCompare(right.account.label)).map(({ account, usage }) => {
      const actions = [
        ...(harness.logoutArgv && account.authKind === 'vendor-cli' && account.status === 'ready'
          ? [{ label: 'Disconnect', value: 'disconnect' }] : []),
        ...(harness.loginArgv && account.authKind === 'vendor-cli' && account.status !== 'ready'
          ? [{ label: 'Reauthenticate', value: 'reauthenticate' }] : []),
      ];
      return {
        label: account.label,
        detail: `${usage ? `· ${usage} ` : ''}${account.status !== 'ready' ? `· ${chalk.yellow('needs sign-in')} ` : ''}${account.quotaState === 'exhausted' ? `· ${chalk.yellow('quota exhausted')} ` : ''}${account.id === session.accountId ? '· current' : ''}${actions.length ? ` ${chalk.dim('(→ for options)')}` : ''}`.trim(),
        value: { kind: 'account' as const, harness: harness.command, accountId: account.id },
        actions,
      };
    }),
    { label: '+ Add account…', detail: `· ${harness.displayName}`, value: { kind: 'add-account', harness: harness.command } },
  ];
}

async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string): Promise<string> {
  if (selected === '__gateway__') return newGatewayConversation(config, rl, id);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (!requiresProviderHandoff(current, selected) && !current.nativeHarness) {
    await aiHarnessSelect(selected, id);
    return id;
  }
  return newProviderConversation(id, selected);
}

async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  for (;;) {
    const available = await Promise.all(localRouter().AI_LOCAL_HARNESSES
      .filter((harness) => harness.surface === 'terminal' && harness.turn)
      .map(async (harness) => ({ harness, inspection: await inspectNativeHarness(harness, 1_200) })));
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const gatewayConnected = Boolean(ApiClient.getApiKeyForUrl(config, ApiClient.getApiUrl(config)));
    const provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(available, session, gatewayConnected));
    if (!provider) return undefined;
    if (provider.kind === 'gateway') return selectProviderConversation(config, rl, id, '__gateway__');
    const harness = localHarnessForCommand(provider.harness);
    if (!harness) throw new Error(`unknown local harness: ${provider.harness}`);
    for (;;) {
      const accountState = await readState();
      const current = accountState.sessions.find((item) => item.id === id);
      if (!current) throw new Error(`AI session "${id}" was not found`);
      const providerAccounts = accountState.accounts.filter((account) => account.provider === harness.provider);
      if (rl instanceof FullScreenHarnessPrompter && providerAccounts.some((account) => account.authKind === 'vendor-cli')) {
        rl.startWaiting(`loading ${harness.displayName} account usage…`);
      }
      let accountsWithUsage: Array<{ account: AiHarnessAccount; usage?: string }>;
      try {
        accountsWithUsage = await Promise.all(providerAccounts.map(async (account) => ({
          account, usage: await accountUsageLabel(account, accountState),
        })));
      } finally {
        if (rl instanceof FullScreenHarnessPrompter) rl.stopWaiting();
      }
      let actionPerformed = false;
      const selected = await chooseOption(
        rl, `${harness.displayName} accounts`, providerAccountPickerOptions(harness, accountsWithUsage, current),
        async (choice, action) => {
          if (choice.kind !== 'account') return;
          actionPerformed = true;
          await manageAccountAction(rl, choice.accountId, action);
        },
      );
      if (actionPerformed) continue;
      if (!selected) break;
      if (selected.kind === 'account') {
        const targetId = await selectProviderConversation(config, rl, id, selected.harness);
        await aiSessionCommand(targetId, `/settings account ${selected.accountId}`);
        return targetId;
      }
      if (!available.find((item) => item.harness.command === harness.command)?.inspection.installed) {
        activeFullScreenHarness?.startWaiting(`installing ${harness.displayName}…`);
        try { await ensureNativeHarness(harness); } finally { activeFullScreenHarness?.stopWaiting(); }
      }
      const accountLabel = await addAccountForHarness(rl, harness);
      if (!accountLabel) continue;
      const targetId = await selectProviderConversation(config, rl, id, harness.command);
      await aiSessionCommand(targetId, `/settings account ${accountLabel}`);
      return targetId;
    }
  }
}

function harnessAutoPreference(command: string): number {
  if (command === 'codex') return 0;
  if (command === 'claude') return 1;
  return 2;
}

/**
 * Bind a session to its native agent without asking. A session that already
 * names a provider or account is matched to that agent; a session with no
 * signal picks the first installed terminal harness (Codex, then Claude Code,
 * then the rest of the catalog). Returns false only when nothing useful is
 * installed, so the caller can surface one line of guidance instead of a picker.
 */
async function autoSelectSessionHarness(id: string): Promise<boolean> {
  const installedCache = new Map<string, boolean>();
  const isInstalled = async (harness?: AiLocalHarnessDefinition): Promise<boolean> => {
    if (!harness) return false;
    const known = installedCache.get(harness.command);
    if (known !== undefined) return known;
    const inspection = await inspectNativeHarness(harness, 1_500);
    installedCache.set(harness.command, inspection.installed);
    return inspection.installed;
  };
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return false;
  if (session.nativeHarness) return true;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const preferred = localHarnessForProvider(session.provider ?? account?.provider ?? '');
  if (preferred && await isInstalled(preferred)) {
    await aiHarnessSelect(preferred.command, id);
    return true;
  }
  const candidates = localRouter().AI_LOCAL_HARNESSES
    .filter((harness) => harness.surface === 'terminal' && harness.turn)
    .sort((left, right) => harnessAutoPreference(left.command) - harnessAutoPreference(right.command));
  for (const harness of candidates) {
    if (await isInstalled(harness)) {
      await aiHarnessSelect(harness.command, id);
      return true;
    }
  }
  return false;
}

/** Well-known SDK/CLI environment variable names each vendor's own tooling
 * already looks for -- not invented here, just the standard name suggested
 * as a starting point for the env var prompt below. Falls back to a
 * generic <PROVIDER>_API_KEY guess for anything not in this short list. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', qwen: 'DASHSCOPE_API_KEY',
  // Confirmed real and current, not guessed: google-antigravity/antigravity-cli
  // issue #632 was closed 2 days before this was written (state_reason:
  // "completed"), with a maintainer's exact working recipe --
  // GEMINI_API_KEY plus modelProvider:"gemini" in the CLI's own
  // settings.json (handled below, in addApiKeyAccount itself, since this
  // map only carries the env var name). Cross-checked against the actual
  // installed binary: modelProvider is a real, present string in it. This
  // matters specifically because it's the only way to authenticate
  // Antigravity CLI that stays inside ClikCode at all -- it has no login
  // subcommand of its own (confirmed via --help), only a full interactive
  // TUI otherwise.
  antigravity: 'GEMINI_API_KEY',
};

async function addApiKeyAccount(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  const suggested = PROVIDER_API_KEY_ENV[harness.provider] ?? `${harness.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  let entered: string;
  try {
    entered = (await rl.question(`Environment variable holding the key ${chalk.dim(`[${suggested}]`)} › `, [], { cancellable: true })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_CANCELLED') return undefined;
    throw error;
  }
  const envName = (entered || suggested).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error('environment variable name must be letters, numbers, and underscores only');
  if (!process.env[envName]) throw new Error(`${envName} is not set in this shell -- export it first, then try again. ClikCode never asks for or stores the raw key itself, only this reference.`);
  // Antigravity CLI needs one more thing beyond the env var itself: its
  // own settings.json must set modelProvider to "gemini", or it ignores
  // GEMINI_API_KEY entirely and falls back to OAuth (confirmed directly:
  // a maintainer's exact recipe on the now-closed antigravity-cli#632, plus
  // real user reports on #78 of the env var alone having no effect without
  // it). No isolated profile exists for this harness (confirmed: no
  // profileEnv), so this is always the one real, global settings file --
  // merged in, not overwritten, so any of the user's other settings
  // (colorScheme, permissions, trustedWorkspaces, etc.) survive untouched.
  if (harness.command === 'antigravity') {
    const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>; } catch { /* no existing settings file yet */ }
    if (settings.modelProvider !== 'gemini') {
      settings.modelProvider = 'gemini';
      await mkdir(join(settingsPath, '..'), { recursive: true });
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }
  }
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const label = `${harness.displayName} (${envName})`;
  const finalLabel = state.accounts.some((account) => account.label === label) ? `${label} ${existingForProvider + 1}` : label;
  await aiAccountAdd({ provider: harness.provider, label: finalLabel, auth: 'api-key', credentialRef: `env:${envName}` });
  return finalLabel;
}

async function addAccountForHarness(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  // Vendor login is the only path this offered before -- but Claude Code
  // (and others) also declare api-key as a supported local auth kind, with
  // no way to actually set one up short of the fully manual, headless-only
  // `accounts add --auth api-key --credential-ref env:VAR` invocation. Only
  // asks when there's a real choice to make; a harness with just one
  // supported local auth kind skips straight to it, same as before.
  //
  // 'vendor-cli' only counts as a real choice when loginArgv actually
  // exists -- caught during a full audit: localAuth is a broader claim
  // ("this provider conceptually supports vendor-cli auth"), separate from
  // whether this catalog has a scriptable command to perform it. Several
  // harnesses (Aider, Goose, Crush, Factory Droid, Kiro CLI) declare
  // vendor-cli in localAuth with no loginArgv at all -- offering "Vendor
  // login" for those would fall through to aiAccountLogin's own
  // `harness.loginArgv ?? []` default and run the bare binary with no
  // arguments, which isn't a login flow for any of them.
  const choices = harness.localAuth.filter((kind) => (kind === 'vendor-cli' && harness.loginArgv) || kind === 'api-key');
  // Factory Droid and Kiro CLI currently land here: oauth-only in localAuth
  // (no api-key) and no loginArgv either, so there's genuinely no way for
  // this catalog to add an account for them yet -- rather than fabricate a
  // login command that isn't verified, say so plainly instead of silently
  // doing nothing (choices[0] being undefined used to fall through to the
  // same "if (!authKind) return" as a real cancel, indistinguishable from
  // one).
  if (choices.length === 0) throw new Error(`${harness.displayName} doesn't publish a login command or a supported API-key auth mode yet -- nothing here can add an account for it.`);
  const authKind = choices.length > 1
    ? await chooseOption(rl, `Sign in to ${harness.displayName} with`, [
        { label: 'Vendor login', detail: 'opens the CLI’s own sign-in flow', value: 'vendor-cli' as const },
        { label: 'API key', detail: 'reference an environment variable, never typed here', value: 'api-key' as const },
      ])
    : choices[0];
  if (!authKind) return undefined;
  if (authKind === 'api-key') {
    return addApiKeyAccount(rl, harness);
  }
  // No name prompt: aiAccountLogin picks a numbered placeholder up front and
  // replaces it with something derived from the harness's own credentials
  // once login actually completes, wherever that's possible -- one less
  // step than asking the user to type or confirm a name themselves.
  //
  // suspend/resume around this call, previously missing here entirely: the
  // one place aiHarnessSelect's own login flow has always had this, but
  // this second entry point into the exact same loginNativeHarness spawn
  // didn't. Claude Code's own login (print a URL, wait for a pasted code)
  // happens to tolerate running without it, which is why this went
  // unnoticed -- but a harness whose login is a full interactive TUI
  // needing exclusive terminal control (Antigravity CLI's bubbletea, which
  // opens /dev/tty directly) has no business running while ClikCode's own
  // raw-mode/alt-screen state is still active competing for the same
  // terminal.
  let label: string;
  if (harness.loginCapturable && rl instanceof FullScreenHarnessPrompter) {
    rl.startWaiting(`signing in to ${harness.displayName}…`);
    try { label = await aiAccountLogin(harness.command); } finally { rl.stopWaiting(); }
  } else if (rl instanceof FullScreenHarnessPrompter) {
    await rl.suspend();
    try {
      announceBareInteractiveLogin(harness);
      label = await aiAccountLogin(harness.command);
    } finally { rl.resume(); }
  } else {
    label = await aiAccountLogin(harness.command);
  }
  return label;
}

async function manageAccountAction(rl: HarnessPrompter, accountId: string, action: string): Promise<void> {
  const state = await readState();
  const account = state.accounts.find((item) => item.id === accountId);
  const harness = account ? localHarnessForProvider(account.provider) : undefined;
  if (!account || !harness || account.authKind !== 'vendor-cli') return;
  const environment = nativeProfileEnvironment(account.nativeProfile);
  if (action === 'disconnect' && harness.logoutArgv) {
    await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
    account.status = 'needs_login';
    await writeState(state);
  } else if (action === 'reauthenticate' && harness.loginArgv) {
    if (harness.loginCapturable && rl instanceof FullScreenHarnessPrompter) {
      rl.startWaiting(`signing in to ${harness.displayName}…`);
      try { await loginNativeHarness(harness, environment); } finally { rl.stopWaiting(); }
    } else if (rl instanceof FullScreenHarnessPrompter) {
      await rl.suspend();
      try {
        announceBareInteractiveLogin(harness);
        await loginNativeHarness(harness, environment);
      } finally { await rl.resume(); }
    } else {
      await loginNativeHarness(harness, environment);
    }
    await syncAccountIdentityAfterLogin(harness, account, state);
  }
}


async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string } | undefined> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  // A session with no turns yet has nothing to resume into — showing it here is
  // indistinguishable from a real conversation until you're already inside it,
  // and older empty sessions (from before aiSessionClose started dropping them)
  // otherwise bury every real, titled conversation under identical
  // "Untitled chat" entries. Always keep the current session visible even if
  // it's still empty, so picking "current" back out of the list still works.
  // A set nativeSessionId counts as real content too, even with zero
  // ClikCode-tracked messages: a session adopted from a vendor's own history,
  // or linked to one directly, has a real vendor-side conversation behind it
  // that ClikCode simply never routed a turn through yet.
  const sessions = state.sessions
    .filter((session) => session.id === currentId || (session.messages ?? []).length > 0 || Boolean(session.nativeSessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  // Conversations that exist only inside a vendor's own history — never opened
  // through ClikCode — are otherwise invisible here entirely: /resume only ever
  // looked at ClikCode's own tracked sessions. Two independent mechanisms feed
  // this, because vendors expose their own history in genuinely different
  // ways: a machine-readable CLI listing via discoverArgv (confirmed live:
  // opencode, Hermes; confirmed only against docs/source, not installed here:
  // Qwen Code, Crush; declared but with an unconfirmed JSON shape: Goose,
  // Kilo Code; a real command with no JSON mode at all, needing its own
  // numbered-list parser: Gemini CLI) — or, for harnesses that publish no
  // listing command whatsoever, reading their own on-disk session files
  // directly (confirmed live: Claude Code, Codex, Cursor Agent; docs-only,
  // unverified against a real install: Pi). GitHub Copilot CLI, Aider, Amp,
  // Factory Droid, Kiro CLI, Cline CLI, and Command Code are deliberately not
  // wired in at all: each either has no local listing mechanism (Aider, Amp's
  // canonical store is server-side), an undocumented on-disk format (Copilot
  // CLI, Factory Droid, Kiro CLI, Cline CLI), or an unresolved identity
  // mismatch between this catalog's entry and the only public docs found for
  // its name (Command Code) — none of these are guessed at.
  const workspace = current?.workspace ?? process.cwd();
  const discoveryProfiles = (harness: AiLocalHarnessDefinition): Array<AiHarnessAccount | undefined> => {
    const accounts = state.accounts.filter((item) => item.provider === harness.provider && item.status === 'ready');
    if (!accounts.length) return [undefined];
    const unique = new Map<string, AiHarnessAccount>();
    for (const account of accounts) unique.set(account.nativeProfile?.path ?? 'default', account);
    return [...unique.values()];
  };
  const discoverable = localRouter().AI_LOCAL_HARNESSES.filter((harness) => harness.session?.discoverArgv);
  const shellDiscovered = (await Promise.all(discoverable.map(async (harness) => {
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const environment = nativeProfileEnvironment(account?.nativeProfile);
      const found = await discoverNativeSessions(harness, environment, workspace);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  const fsDiscovered = (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const found = await discover(workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  const discovered = [...shellDiscovered, ...fsDiscovered]
    .filter(({ harness, item, accountId }) => !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
  // Every option gets a single real recency key so the newest conversation is
  // always near the top regardless of which source found it — grouping by
  // source first (every ClikCode session, then every opencode result, then
  // every Hermes result, ...) buried a two-minutes-old live Claude Code
  // session below Hermes entries from June, since each *group* was sorted
  // internally but the groups themselves were never interleaved. A source
  // with no real timestamp (an unparsed vendor display string) sorts last
  // rather than claiming a false position.
  const groupedOptions = sessionPickerOptions(sessions, currentId);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const trackedBlocks = new Map<string, { sortKey: number; options: PickerOption<string>[] }>();
  for (const option of groupedOptions) {
    const session = sessionsById.get(option.value)!;
    const root = conversationIdFor(session);
    const updatedAt = Date.parse(session.updatedAt);
    const block = trackedBlocks.get(root) ?? { sortKey: -Infinity, options: [] };
    block.sortKey = Math.max(block.sortKey, Number.isNaN(updatedAt) ? -Infinity : updatedAt);
    block.options.push(option);
    trackedBlocks.set(root, block);
  }
  const optionBlocks = [
    ...trackedBlocks.values(),
    ...discovered.map(({ harness, item, accountId }, index) => ({
      sortKey: item.updatedAtMs ?? -Infinity,
      options: [{
        label: `${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
        detail: `· not yet in ClikCode${accountId ? ` · ${state.accounts.find((account) => account.id === accountId)?.label ?? 'linked account'}` : ''}${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
        value: `native:${index}`,
      }],
    })),
  ].sort((left, right) => right.sortKey - left.sortKey);
  // Conversation roots and unadopted native sessions share one recency order.
  // Provider hops stay behind each root row's right-arrow history.
  const options = optionBlocks.flatMap((block) => block.options);
  const selected = await chooseOption(rl, 'Resume a session', options);
  if (!selected) return undefined;
  if (!selected.startsWith('native:')) return { id: selected };
  const match = discovered[Number.parseInt(selected.slice('native:'.length), 10)];
  if (!match) return undefined;
  const nativeId = match.item.nativeId;
  const account = match.accountId
    ? state.accounts.find((item) => item.id === match.accountId)
    : state.accounts.find((item) => item.provider === match.harness.provider && item.status === 'ready');
  const defaults = resolveDefaultSettings(state, match.harness.provider);
  const now = new Date().toISOString();
  // The vendor's own thread already has full context regardless — adopting
  // its identity alone is enough for continuation to work correctly the
  // moment a turn is sent. Populating ClikCode's own transcript view too is a
  // separate, best-effort read: only wired for the harnesses with a confirmed
  // way to read a whole conversation back out (see ADOPTED_TRANSCRIPT_READERS
  // above), and never something continuation itself depends on.
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader
    ? await transcriptReader(match.harness, nativeId, workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => [])
    : [];
  const id = randomUUID();
  const adopted: HarnessSession = {
    id, conversationId: id, route: 'local', accountId: account?.id ?? null, provider: match.harness.provider,
    model: null, effort: defaults.effort, permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
    createdAt: now, updatedAt: now, status: 'active',
    nativeHarness: match.harness.command, nativeSessionId: nativeId, nativeStartedAt: now,
    workspace, name: match.item.title, ...(messages.length ? { messages } : {}),
  };
  state.sessions.push(adopted);
  await writeState(state);
  // Picking a specific vendor's own chat by name is an explicit choice to open
  // it as that vendor — forcing it onto whatever provider was already active
  // (the same-conversation /resume behavior below) would immediately discard
  // the native session id just adopted, undoing the entire point of listing it.
  return { id: adopted.id };
}

async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  const catalog = harness ? await nativeModelCatalog(harness, account) : { models: account?.models ?? [] };
  const effective = session.model ?? catalog.configured;
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => {
      const parts = [
        catalog.labels?.[model],
        model === effective ? 'current' : undefined,
        model === effective && !session.model && model === catalog.configured ? 'provider configured' : undefined,
      ].filter((part): part is string => Boolean(part));
      return { label: model, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
    }),
    { label: 'Automatic provider default', detail: effective ? undefined : '· current', value: 'default' },
    { label: 'Enter a model ID…', value: '__custom__' },
  ];
  const selected = await chooseOption(rl, 'Choose a model', options);
  if (!selected) return;
  const value = selected === '__custom__' ? (await rl.question('Model ID › ')).trim() : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) await aiSessionCommand(id, `/model ${value}`);
}

async function interactiveSessionManager(rl: HarnessPrompter, id: string): Promise<'resume' | 'exit' | undefined> {
  const action = await chooseOption(rl, 'Conversations', [
    { label: 'Resume another…', value: 'resume' },
    { label: 'Start clean', detail: 'reset provider context', value: 'new' },
    { label: 'Rename', value: 'rename' },
    { label: 'Fork', detail: 'copy transcript into a new conversation', value: 'fork' },
    { label: 'Archive', value: 'archive' },
    { label: 'Delete', detail: 'remove local ClikCode history', value: 'delete' },
  ] as const);
  if (!action) return undefined;
  if (action === 'resume') return 'resume';
  if (action === 'new') { await aiSessionCommand(id, '/new'); return undefined; }
  if (action === 'rename') {
    const name = (await rl.question('Conversation name › ')).trim();
    if (name) await aiSessionCommand(id, `/rename ${name}`);
    return undefined;
  }
  if (action === 'fork') { await aiSessionCommand(id, '/fork'); return undefined; }
  if (action === 'archive') {
    const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') { await aiSessionCommand(id, '/archive'); return 'exit'; }
    return undefined;
  }
  const answer = (await rl.question('Delete this conversation from ClikCode? Type delete › ')).trim().toLowerCase();
  if (answer === 'delete') { await aiSessionCommand(id, '/delete confirm'); return 'exit'; }
  return undefined;
}

/** After picking a new value, ask what it applies to instead of making that a
 * separate "Defaults for new chats" menu that asks the same question about the
 * same settings a second time. One flow per setting: choose the value, then
 * choose the scope. */
async function applySettingScope(
  rl: HarnessPrompter, id: string, key: 'effort' | 'permissions' | 'failover' | 'model', value: string,
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const scope = await chooseOption(rl, 'Apply to', [
    { label: 'This chat only', value: 'session' as const },
    { label: 'Global default', detail: 'every provider, unless overridden', value: 'global' as const },
    ...(harness ? [{ label: `${harness.displayName} default`, detail: 'this provider only', value: 'provider' as const }] : []),
  ]);
  if (!scope) return;
  if (scope === 'session') {
    if (key === 'failover') await aiSessionCommand(id, `/accounts failover ${value}`);
    else await aiSessionCommand(id, `/${key} ${value}`);
  } else if (scope === 'global') {
    await aiSettingsSetGlobal(key, value);
  } else if (harness) {
    await aiSettingsSetProvider(harness.command, key, value);
  }
}

async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway reasoning effort is selected by platform routing policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
  const effortOption = harness ? optionForHarness(harness, 'effort') : undefined;
  const efforts = effortOption?.values?.length ? effortOption.values : VALID_EFFORTS;
  const selected = await chooseOption(rl, 'Choose reasoning effort', efforts.map((value) => ({
    label: value, detail: value === session.effort ? '· current' : undefined, value,
  })));
  if (selected) await applySettingScope(rl, id, 'effort', selected);
}

async function interactiveHarnessOptionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  const option = await chooseOption(rl, `${harness.displayName} options`, manifest.options.map((item) => ({
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

async function interactivePermissionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const current = session.permissionMode ?? 'ask';
  const descriptions: Record<AiHarnessPermissionMode, string> = {
    ask: 'require approval; unanswered headless prompts are denied',
    bypass: 'run without approval prompts',
    auto: 'provider reviews approval requests automatically',
  };
  const supported = harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : VALID_PERMISSION_MODES;
  if (!supported.length) throw new Error(`${harness?.displayName ?? 'This provider'} does not map ClikCode's permission modes to a real flag.`);
  const selected = await chooseOption(rl, 'Choose permissions', supported.map((value) => ({
    label: value[0].toUpperCase() + value.slice(1), detail: `· ${descriptions[value]}${value === current ? ' · current' : ''}`, value,
  })));
  if (selected) await applySettingScope(rl, id, 'permissions', selected);
}

async function interactiveFailoverPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = session.accountFailover ?? 'on-quota-exhausted';
  const selected = await chooseOption(rl, 'Quota failover', [
    { label: 'Auto-switch accounts', detail: `· switch to another ready account of the same provider when quota runs out${current === 'on-quota-exhausted' ? ' · current' : ''}`, value: 'auto' },
    { label: 'Never', detail: `· stop and ask instead of switching${current === 'never' ? ' · current' : ''}`, value: 'never' },
  ]);
  if (selected) await applySettingScope(rl, id, 'failover', selected);
}

async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const selected = await chooseOption(rl, 'Settings', [
    { label: 'Provider & account', detail: 'choose a harness, login, or add an account', value: 'provider' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: 'provider default or model ID', value: 'model' }] : []),
    ...(harness && harnessSupportsEffort(harness) ? [{ label: 'Reasoning effort', detail: 'provider-supported levels', value: 'effort' }] : []),
    ...(harness?.permissionModes?.length ? [{ label: 'Permissions', detail: 'provider-supported approval behavior', value: 'permissions' }] : []),
    ...(harness && localHarnessCapabilityManifest(harness).options.some((option) => !['model', 'effort', 'workspace', 'permissions'].includes(option.id))
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    { label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover' },
    { label: 'Show current setup', value: 'status' },
  ] as const);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'model') await interactiveModelPicker(rl, id);
  else if (selected === 'effort') await interactiveEffortPicker(rl, id);
  else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
  else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
  else if (selected === 'failover') await interactiveFailoverPicker(rl, id);
  else if (selected === 'status') await aiSessionCommand(id, '/status');
  return undefined;
}

/** Persistent terminal session using the same command and routing surface as automation. */
export async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  // A long-lived interactive session should survive a transient terminal
  // hangup (a flaky/mobile SSH connection dropping and reconnecting mid-use
  // is exactly the kind of thing this hits), not die from it. Node's
  // default action for an unhandled SIGHUP is immediate termination --
  // before any try/catch, before uncaughtException, before anything this
  // process could do about it. run()'s own SIGHUP forwarding only covers
  // the narrow window a login/turn subprocess is actually running; a
  // hangup arriving in any of the gaps around that (mid-suspend, during
  // identity derivation, mid-render) previously killed the whole process
  // silently -- explaining a real, reproduced case where the account never
  // saved because ClikCode itself was gone, with no crash log at all
  // (SIGHUP's default handling pre-empts JS entirely; there was nothing
  // for a crash handler to catch). Ignoring it here covers the session's
  // entire lifetime, not just subprocess windows. SIGINT gets the identical
  // treatment for a related but distinct reason: run()'s own Ctrl+C
  // forwarding to a login/turn subprocess is removed the INSTANT that
  // subprocess exits -- but the terminal stays in cooked mode (raw mode
  // off, from suspend()) for everything that happens after, including this
  // codebase's own identity-derivation retry loop, which can legitimately
  // run for several seconds with nothing visibly changing on screen. A
  // Ctrl+C landing in that specific gap -- a completely natural thing to do
  // when the screen looks idle right after pasting an auth code --
  // previously had no handler registered at all, so Node's default SIGINT
  // action (immediate termination) applied, killing the process mid-save.
  // While raw mode IS active (the normal composer state), Ctrl+C is read
  // as data (byte 0x03) handled entirely inside this UI, never reaching
  // the OS as a real signal at all -- so ignoring the signal here changes
  // nothing about that existing, working "cancel the current turn"
  // behavior; it only closes the gap where raw mode is temporarily off and
  // nothing else is watching. /exit and /quit remain the ways to leave.
  const ignoreHangup = (): void => {};
  const ignoreInterrupt = (): void => {};
  process.on('SIGHUP', ignoreHangup);
  process.on('SIGINT', ignoreInterrupt);
  try {
    await aiSessionInteractiveInner(config, id);
  } finally {
    process.off('SIGHUP', ignoreHangup);
    process.off('SIGINT', ignoreInterrupt);
  }
}

async function aiSessionInteractiveInner(config: Conf, id: string): Promise<void> {
  const state = await readState();
  let session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (await synchronizeNativeTranscript(state, session)) await writeState(state);
  const commandDetails: Record<string, string> = {
    '/provider': 'choose a provider or one of its accounts', '/settings': 'configure this workspace',
    '/model': 'choose or view a model', '/effort': 'reasoning level', '/permissions': 'approval behavior',
    '/sessions': 'manage conversations', '/resume': 'resume another conversation', '/new': 'start clean',
    '/history': 'show transcript', '/diff': 'show project changes', '/review': 'review project changes',
    '/init': 'create agent instructions', '/mention': 'attach a file', '/attachments': 'queued files', '/copy': 'copy last response',
    '/rename': 'rename conversation', '/fork': 'fork conversation', '/archive': 'archive conversation', '/delete': 'delete conversation',
    '/options': 'provider-specific modes and controls', '/capabilities': 'selected provider capabilities',
    '/status': 'current configuration', '/usage': 'token usage', '/clear': 'refresh screen',
    '/help': 'all commands', '/exit': 'save and leave',
  };
  const slashCommandsFor = (target: HarnessSession): PickerOption<string>[] => {
    const harness = target.nativeHarness ? localHarnessForCommand(target.nativeHarness) : undefined;
    const managers = harness ? localHarnessCapabilityManifest(harness).managers ?? {} : {};
    return [
      ...Object.keys(commandDetails).map((value) => ({ label: value, detail: commandDetails[value], value })),
      ...Object.entries(managers).map(([name, manager]) => ({ label: `/${name}`, detail: manager?.label ?? name, value: `/${name}` })),
      ...localRouter().AI_LOCAL_HARNESSES.filter((item) => item.surface === 'terminal').map((item) => ({
        label: `/${item.command}`, detail: `switch to ${item.displayName}`, value: `/${item.command}`,
      })),
    ];
  };
  // Created before auto-select so a first-ever install/sign-in — the most
  // common time either is actually needed — has somewhere to show its
  // "installing…" spinner and a real terminal to suspend into for a vendor
  // login prompt, instead of running headless before the UI exists.
  const rl: HarnessPrompter = input.isTTY && output.isTTY
    ? new FullScreenHarnessPrompter()
    : createInterface({
      input, output, terminal: false, historySize: 1_000, removeHistoryDuplicates: true,
      completer: (value: string) => {
        const fallbackCommands = slashCommandsFor(session!).map((item) => item.value);
        const matches = fallbackCommands.filter((command) => command.startsWith(value));
        return [matches.length ? matches : fallbackCommands, value] as [string[], string];
      },
    });
  if (rl instanceof FullScreenHarnessPrompter) activeFullScreenHarness = rl;
  rl.render?.(session);
  if (!session.nativeHarness && session.route !== 'gateway') {
    const auto = await autoSelectSessionHarness(id);
    if (!auto) {
      const selected = await interactiveEnginePicker(config, rl, id);
      if (!selected) return;
      if (selected !== id) id = selected;
    }
    const refreshed = await readState();
    const next = refreshed.sessions.find((item) => item.id === id);
    if (!next) return;
    session = next;
  }
  let stateChanged = false;
  if (session.status !== 'active') {
    session.status = 'active';
    session.closedAt = undefined;
    session.updatedAt = new Date().toISOString();
    stateChanged = true;
  }
  if (!session.model) {
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (harness) {
      const catalog = await nativeModelCatalog(harness, account);
      if (catalog.configured) {
        session.model = catalog.configured;
        session.updatedAt = new Date().toISOString();
        stateChanged = true;
      }
    }
  }
  if (stateChanged) await writeState(state);
  const initialAccount = session.accountId ? state.accounts.find((account) => account.id === session.accountId)?.label : undefined;
  if (rl.render) rl.render(session, initialAccount);
  else emitHarnessOutput({ status: 'ready', session, account: initialAccount });
  const refreshUsage = (target: HarnessSession, targetState: HarnessState): void => {
    if (!(rl instanceof FullScreenHarnessPrompter)) return;
    void nativeUsageLabel(target, targetState).then((label) => {
      if (activeFullScreenHarness === rl) rl.usage(label);
    }).catch(() => { /* Usage is optional provider metadata. */ });
  };
  refreshUsage(session, state);
  // Without this, usage only ever refreshed at session-open and right after
  // each submitted message -- fine for a quick back-and-forth, but a long
  // turn or an idle stretch between messages left the number sitting there
  // stale for however long that gap was, well past nativeUsageLabel's own
  // 30s cache window (which bounds *how often this can update*, not
  // *whether anything ever asks it to*). This is what actually asks.
  const usageInterval = rl instanceof FullScreenHarnessPrompter ? setInterval(() => {
    void readState().then((latestState) => {
      const latest = latestState.sessions.find((item) => item.id === id);
      if (latest) refreshUsage(latest, latestState);
    }).catch(() => { /* Usage is optional provider metadata. */ });
  }, 20_000) : undefined;
  let notice: string | undefined;
  let synchronizedSessionId = id;
  try {
    while (true) {
      let line: string;
      let activeWorkspace = process.cwd();
      try {
        const latestState = await readState();
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) break;
        activeWorkspace = latest.workspace ?? process.cwd();
        if (synchronizedSessionId !== id) {
          if (await synchronizeNativeTranscript(latestState, latest)) await writeState(latestState);
          synchronizedSessionId = id;
        }
        const account = latest.accountId ? latestState.accounts.find((item) => item.id === latest.accountId)?.label : undefined;
        rl.render?.(latest, account, notice);
        refreshUsage(latest, latestState);
        notice = undefined;
        line = (await rl.question('› ', slashCommandsFor(latest))).trim();
      } catch (error) {
        // A non-interactive caller may close stdin after its final command.
        // Treat that exactly like leaving the foreground harness, not a crash.
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (!line) continue;
      if (line === '/exit' || line === '/quit') {
        await aiSessionLeave(id);
        break;
      }
      let interruptedSubmission: { text: string; restoreOnEscape: boolean } | undefined;
      try {
        const command = line.toLowerCase();
        const standaloneAttachment = await resolveStandaloneAttachment(line, activeWorkspace);
        if (command === '/switch' || command === '/engine' || command === '/provider') {
          const selected = await interactiveEnginePicker(config, rl, id);
          if (selected && selected !== id) { id = selected; continue; }
        }
        else if (command === '/account' || command === '/accounts') {
          const selected = await interactiveEnginePicker(config, rl, id);
          if (selected && selected !== id) { id = selected; continue; }
        }
        else if (command === '/model') await interactiveModelPicker(rl, id);
        else if (command === '/effort') await interactiveEffortPicker(rl, id);
        else if (command === '/permissions') await interactivePermissionPicker(rl, id);
        else if (command === '/options') await interactiveHarnessOptionPicker(rl, id);
        else if (command === '/capabilities') {
          const commandState = await readState();
          const commandSession = commandState.sessions.find((item) => item.id === id);
          if (commandSession?.route === 'gateway') {
            rl.panel?.('ClikDeploy Gateway capabilities', [
              'Inference routing: platform managed',
              'Streaming: live SSE token deltas with bounded fallback chunking',
              'Tools: ClikDeploy capability registry and MCP bridge',
              'Permissions: authenticated server policy and confirmation gates',
              'Sessions: durable ClikCode transcript replay',
              'Models and effort: selected by Gateway routing policy',
            ].join('\n'));
            if (rl.render) await rl.question('Press Enter to return › ');
            continue;
          }
          const selectedHarness = commandSession?.nativeHarness ? localHarnessForCommand(commandSession.nativeHarness) : undefined;
          if (!selectedHarness) throw new Error('Choose a provider first.');
          const manifest = localHarnessCapabilityManifest(selectedHarness);
          const lines = [
            ...manifest.options.map((option) => `${option.label}: ${option.description}`),
            ...Object.entries(manifest.managers ?? {}).map(([name, manager]) => `${manager?.label ?? name}: available`),
            ...(manifest.features ?? []).map((feature) => `${feature}: native`),
          ];
          rl.panel?.(`${selectedHarness.displayName} capabilities`, lines.join('\n'));
          if (rl.render) await rl.question('Press Enter to return › ');
        }
        else if (command === '/settings') {
          const selected = await interactiveSettingsPicker(config, rl, id);
          if (selected && selected !== id) { id = selected; continue; }
        }
        else if (command.startsWith('/settings global ')) {
          const [, , key, ...rest] = line.trim().split(/\s+/);
          if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|failover> <value>');
          await aiSettingsSetGlobal(key, rest.join(' '));
          notice = `Global default updated: ${key} = ${rest.join(' ')}`;
        }
        else if (command.startsWith('/settings provider ')) {
          const [, , providerId, key, ...rest] = line.trim().split(/\s+/);
          if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions|failover> <value>, or /settings provider <id> clear');
          if (key.toLowerCase() === 'clear') {
            await aiSettingsClearProvider(providerId);
            notice = `Provider defaults cleared for ${providerId}`;
          } else {
            if (!rest.length) throw new Error('usage: /settings provider <id> <key> <value>');
            await aiSettingsSetProvider(providerId, key, rest.join(' '));
            notice = `${providerId} default updated: ${key} = ${rest.join(' ')}`;
          }
        }
        else if (command === '/sessions') {
          const action = await interactiveSessionManager(rl, id);
          if (action === 'exit') break;
          if (action === 'resume') {
            const selected = await interactiveSessionPicker(rl, id);
            if (selected && selected.id !== id) { id = selected.id; continue; }
          }
        }
        else if (command === '/rename') {
          const name = (await rl.question('Conversation name › ')).trim();
          if (name) await aiSessionCommand(id, `/rename ${name}`);
        }
        else if (command === '/archive' || command === '/delete') {
          const action = command === '/archive' ? 'archive' : 'delete';
          const answer = (await rl.question(`${action === 'archive' ? 'Archive' : 'Delete'} this conversation? ${action === 'delete' ? 'Type delete' : '[y/N]'} › `)).trim().toLowerCase();
          if ((action === 'archive' && ['y', 'yes'].includes(answer)) || (action === 'delete' && answer === 'delete')) {
            await aiSessionCommand(id, action === 'archive' ? '/archive' : '/delete confirm');
            break;
          }
        }
        else if (command === '/resume') {
          const selected = await interactiveSessionPicker(rl, id);
          if (selected && selected.id !== id) {
            // Resume means reopening the selected conversation at its source:
            // retain its account, harness, and exact native session identity.
            // Moving a transcript to another provider remains an explicit
            // /provider action, never a side effect of choosing history.
            id = selected.id;
            continue;
          }
        }
        else if (command === '/clear') rl.render?.(session);
        else if (['/mcp', '/skills', '/plugins', '/agents', '/hooks', '/tools'].includes(command)) {
          const managerName = command.slice(1) as 'mcp' | 'skills' | 'plugins' | 'agents' | 'hooks' | 'tools';
          const commandState = await readState();
          const commandSession = commandState.sessions.find((item) => item.id === id);
          const selectedHarness = commandSession?.nativeHarness ? localHarnessForCommand(commandSession.nativeHarness) : undefined;
          if (!selectedHarness) throw new Error('Choose a provider first.');
          const manager = localHarnessCapabilityManifest(selectedHarness).managers?.[managerName];
          if (!manager) throw new Error(`${selectedHarness.displayName} does not publish a ${managerName} manager.`);
          const selectedAccount = commandSession?.accountId ? commandState.accounts.find((item) => item.id === commandSession.accountId) : undefined;
          const environment = nativeProfileEnvironment(selectedAccount?.nativeProfile);
          if (manager.listArgv) {
            const result = await captureNativeHarnessOutput(selectedHarness, manager.listArgv, environment);
            rl.panel?.(manager.label, result || 'No entries.');
            if (rl.render) await rl.question('Press Enter to return › ');
          } else if (manager.manageArgv && rl instanceof FullScreenHarnessPrompter) {
            await rl.suspend();
            try { await runNativeHarnessCommand(selectedHarness, manager.manageArgv, environment); }
            finally { rl.resume(); }
          } else throw new Error(`${selectedHarness.displayName} requires an interactive terminal for ${manager.label}.`);
        }
        else if (command === '/mention') {
          const path = (await rl.question('File to attach › ')).trim();
          if (path) await aiSessionCommand(id, `/mention ${path}`);
        }
        else if (command === '/review' || command.startsWith('/review ') || command === '/init') {
          const extra = command.startsWith('/review ') ? line.slice('/review '.length).trim() : '';
          const task = command === '/init'
            ? 'Inspect this repository and create or improve AGENTS.md with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.'
            : `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`;
          const turnController = new AbortController();
          activeFullScreenHarness?.startWaiting('thinking', () => turnController.abort());
          try { await aiGatewaySessionSend(config, id, task, turnController.signal); }
          finally { activeFullScreenHarness?.stopWaiting(); }
        }
        else if (standaloneAttachment) {
          const attachmentState = await readState();
          const attachmentSession = attachmentState.sessions.find((item) => item.id === id);
          if (!attachmentSession) throw new Error(`AI session "${id}" was not found`);
          await queueAttachment(attachmentSession, standaloneAttachment);
          attachmentSession.updatedAt = new Date().toISOString();
          await writeState(attachmentState);
          notice = `Attached ${compactPath(standaloneAttachment)} for the next request`;
          if (!rl.render) emitHarnessOutput({ panel: 'attachments', attachments: attachmentSession.attachments ?? [] });
          continue;
        }
        else if (line.startsWith('/') && !line.includes(' ') && localHarnessForCommand(command.slice(1))) {
          const selected = await newProviderConversation(id, command.slice(1));
          id = selected;
          continue;
        }
        else if (line.startsWith('/')) {
          await aiSessionCommand(id, line);
          const head = command.split(/\s+/, 1)[0];
          if (rl.render && ['/help', '/status', '/models', '/usage', '/history', '/diff', '/attachments', '/copy', '/fork', '/capabilities', '/mcp', '/skills', '/plugins', '/agents', '/hooks', '/tools'].includes(head)) {
            await rl.question('Press Enter to return › ');
          }
        }
        else {
          const activeState = await readState();
          const active = activeState.sessions.find((item) => item.id === id);
          const activeAccount = active?.accountId ? activeState.accounts.find((item) => item.id === active.accountId)?.label : undefined;
          if (active && rl.render) {
            const pending: HarnessSession = {
              ...active,
              messages: [...(active.messages ?? []), { role: 'user' as const, content: line }].slice(-40),
            };
            rl.render(pending, activeAccount);
            const turnController = new AbortController();
            interruptedSubmission = { text: line, restoreOnEscape: false };
            activeFullScreenHarness?.startWaiting('thinking', (restoreDraft) => {
              interruptedSubmission!.restoreOnEscape = restoreDraft;
              turnController.abort();
            });
            try { await aiGatewaySessionSend(config, id, line, turnController.signal); }
            finally { activeFullScreenHarness?.stopWaiting(); }
            continue;
          }
          else output.write(`${chalk.dim(`${active ? sessionProviderLabel(active) : 'Provider'} · working…`)}\n`);
          try { await aiGatewaySessionSend(config, id, line); }
          finally { activeFullScreenHarness?.stopWaiting(); }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = (error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError';
        if (cancelled && interruptedSubmission && activeFullScreenHarness) {
          const outputStarted = activeFullScreenHarness.turnOutputStarted();
          const partialResponse = activeFullScreenHarness.liveResponseText();
          if (outputStarted) await preserveInterruptedTurn(id, interruptedSubmission.text, partialResponse, true);
          else if (interruptedSubmission.restoreOnEscape) activeFullScreenHarness.restoreDraft(interruptedSubmission.text);
          notice = outputStarted ? 'Stopped' : interruptedSubmission.restoreOnEscape ? 'Stopped · draft restored' : 'Stopped';
        } else if (rl.render) notice = cancelled ? 'Stopped' : `Error: ${message}`;
        else emitHarnessOutput({ panel: 'error', message });
      }
    }
  } finally {
    if (usageInterval) clearInterval(usageInterval);
    if (activeFullScreenHarness === rl) activeFullScreenHarness = undefined;
    rl.close();
  }
}

/**
 * Runs one durable local session turn. Local sessions resolve an env reference
 * only in this process and record normalized, credential-free usage.
 */
export async function aiSessionSend(id: string, prompt: string, signal?: AbortSignal): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('use aiGatewaySessionSend for gateway sessions');
  if (!session.accountId) throw new Error('local AI session has no account selected');
  let account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  const model = session.model ?? account.models[0] ?? null;
  if (model && account.models.length > 0 && !account.models.includes(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  let turnText = `${text}${prepared.textContext}`;
  const startedAt = Date.now();

  if (account.authKind === 'vendor-cli') {
    const harness = session.nativeHarness
      ? localHarnessForCommand(session.nativeHarness)
      : localHarnessForProvider(account.provider);
    if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
    if (!harness.turn) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
    if (harness.provider !== account.provider) throw new Error(`session provider ${harness.displayName} does not match account "${account.label}"`);
    const supportsImages = harnessSupportsImages(harness);
    const images = supportsImages ? prepared.images : [];
    if (prepared.images.length && !supportsImages) {
      turnText += `\n\nImage files available in the workspace:\n${prepared.images.map((path) => `- ${path}`).join('\n')}`;
    }
    session.nativeHarness = harness.command;
    session.provider = harness.provider;
    session.workspace ??= process.cwd();
    // A fresh native thread (no nativeSessionId yet) with prior ClikCode
    // messages already on the session means this conversation is continuing
    // under a different native identity than whatever produced those messages
    // — a cross-provider /resume, most commonly. ClikCode's own transcript
    // shows continuity either way, but the vendor process about to start has
    // no memory of any of it unless it's carried in the prompt itself; without
    // this, "continuing under Claude Code" is cosmetic in the UI only. The
    // quota-failover retry below does its own version of this for the
    // mid-conversation case; this covers every other route into a fresh
    // native thread with history already behind it.
    if (!session.nativeSessionId && (session.messages ?? []).length > 0) {
      turnText = failoverPrompt(session.messages ?? [], turnText);
    }
    let switchedFrom: string | undefined;
    // Bounded to one attempt: this is a reactive fallback for exactly the
    // case aiHarnessSelect's own proactive check can't catch -- a harness
    // with no statusArgv (nothing to scriptably ask "am I logged in?"
    // before the turn even starts), where the *first* real signal is the
    // turn itself failing. Retrying more than once would risk a loop if
    // login genuinely doesn't fix it (wrong account, network issue, etc.).
    let authRetried = false;
    for (;;) {
      const environment = nativeProfileEnvironment(account.nativeProfile);
      let createdHere = false;
      if (!session.nativeSessionId && harness.session?.idKind === 'uuid' && harness.turn.createIdPrefix) {
        session.nativeSessionId = randomUUID();
        createdHere = true;
      } else if (!session.nativeSessionId && harness.session?.idKind === 'history-file' && harness.turn.createIdPrefix) {
        const nativeDirectory = join(harnessStatePath(), '..', 'native', harness.command);
        await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
        session.nativeSessionId = join(nativeDirectory, `${session.id}.history.md`);
        createdHere = true;
      } else if (!session.nativeSessionId && harness.session?.createSessionArgv) {
        session.nativeSessionId = await captureNativeHarness(harness, harness.session.createSessionArgv, environment);
        createdHere = true;
      }
      const argv = localRouter().nativeHarnessTurnArgv(harness, {
        prompt: turnText, nativeSessionId: session.nativeSessionId, createdHere,
        launchedBefore: Boolean(session.nativeStartedAt), model, workspace: session.workspace, effort: session.effort,
        permissionMode: session.permissionMode ?? 'ask', images, options: session.harnessOptions,
      });
      // Persist an allocated native identity before the provider starts so an
      // interrupted turn cannot accidentally fork the centralized conversation.
      if (createdHere) await writeState(state);
      // A rejection here (not just a resolved-but-failed turnOutput) is a
      // real, reproduced case: captureNativeHarnessTurn itself rejects
      // directly whenever the process exits non-zero with no usable
      // stdout -- exactly what a failed native-thread resume looks like
      // (the real error text lands on stderr, nothing meaningful reaches
      // stdout). That threw past every check below before this caught it,
      // making the native-thread-invalid recovery just added completely
      // unreachable for the one failure it was built for. Catching it here
      // and synthesizing a failed result lets the SAME classification and
      // recovery logic below handle both shapes of failure identically.
      let caughtTurnFailure: Error | undefined;
      let turnOutput: Awaited<ReturnType<typeof captureNativeHarnessTurn>> = { stdout: '', stderr: '', exitCode: 0 };
      let result: { text: string; nativeSessionId?: string; isError?: boolean; statusCode?: number } | undefined;
      try {
        if (harness.command === 'codex') {
          result = await runCodexAppServerTurn({
            binary: harness.binary, prompt: turnText, nativeSessionId: session.nativeSessionId,
            cwd: session.workspace, model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask',
            images, environment, signal,
            onSessionId: async (nativeSessionId) => {
              if (session.nativeSessionId === nativeSessionId) return;
              session.nativeSessionId = nativeSessionId;
              await writeState(state);
            },
            onResponseDelta: (delta) => activeFullScreenHarness?.response(delta, 'append'),
            onPhase: (phase) => activeFullScreenHarness?.phase(phase),
            onApproval: (title, detail) => activeFullScreenHarness?.approval(title, detail) ?? Promise.resolve(false),
            onActivity: (event) => {
              activeFullScreenHarness?.phase(renderActivityPhase(event));
              if (isJsonDefaultMode()) return;
              if (activeFullScreenHarness) activeFullScreenHarness.activityEvent(event);
              else for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
            },
          });
        } else {
          turnOutput = await captureNativeHarnessTurn(
            harness, argv, environment, {
              cwd: session.workspace,
              signal,
              stdinText: harness.turn.promptInput === 'stdin' ? turnText : undefined,
              onStdoutLine: (lineText) => {
                const responseUpdate = nativeResponseUpdate(harness, lineText);
                if (responseUpdate) activeFullScreenHarness?.response(responseUpdate.text, responseUpdate.mode);
                const textPhase = nativeActivityPhase(harness, lineText);
                if (textPhase) activeFullScreenHarness?.phase(textPhase);
                const event = parseNativeActivityEvent(harness, lineText);
                if (!event) return;
                activeFullScreenHarness?.phase(renderActivityPhase(event));
                if (isJsonDefaultMode()) return;
                if (activeFullScreenHarness) activeFullScreenHarness.activityEvent(event);
                else for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
              },
            },
          );
          if (turnOutput.interrupted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
          result = nativeTurnResult(harness, turnOutput.stdout);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_TURN_CANCELLED' || (error as Error).name === 'AbortError') throw error;
        caughtTurnFailure = error instanceof Error ? error : new Error(String(error));
      }
      result = caughtTurnFailure
        ? { isError: true, text: caughtTurnFailure.message, statusCode: undefined as number | undefined, nativeSessionId: undefined as string | undefined }
        : result!;
      if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
      // A non-zero exit code alone is not treated as failure here: by this
      // point nativeTurnResult has already thrown if it found no genuine
      // assistant text at all, so result.text existing means a real,
      // complete response was extracted. A harness can legitimately exit
      // non-zero because one internal sub-step failed (e.g. Codex's own
      // shell-command execution) while still producing a full final answer
      // -- the exit code by itself doesn't distinguish that from a genuine
      // failure, but an explicit isError/errorMessage signal does.
      if (caughtTurnFailure || result.isError) {
        const failure = caughtTurnFailure ?? Object.assign(new Error(`${harness.displayName}: ${result.text}`), { statusCode: result.statusCode });
        const failureKind = classifyAccountFailure(failure);
        if (failureKind === 'authentication-required') {
          account.status = 'needs_login';
          await writeState(state);
          // Reactive counterpart to aiHarnessSelect's proactive login check:
          // a harness with no statusArgv gets no pre-turn "are you logged
          // in?" probe at all (harnessNeedsLogin returns false without
          // one), so its first real failure signal is the turn itself
          // erroring out -- previously surfaced as a raw, unhelpful "exited
          // N: {...}" message with no attempt to actually fix it. Same
          // suspend/login/resume mechanism aiHarnessSelect uses, triggered
          // here instead of only at provider-switch time.
          if (!authRetried && activeFullScreenHarness && harness.loginArgv) {
            authRetried = true;
            if (harness.loginCapturable) {
              activeFullScreenHarness.startWaiting(`signing in to ${harness.displayName}…`);
              try { await loginNativeHarness(harness, environment); } finally { activeFullScreenHarness.stopWaiting(); }
            } else {
              activeFullScreenHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
              await activeFullScreenHarness.suspend();
              try {
                await loginNativeHarness(harness, environment);
              } finally {
                activeFullScreenHarness.resume();
              }
            }
            account = await syncAccountIdentityAfterLogin(harness, account, state);
            session.accountId = account.id;
            continue;
          }
        }
        if (failureKind === 'native-thread-invalid') {
          // Confirmed live: switching this session to a different account of
          // the same provider used to leave a stale nativeSessionId in
          // place, and resuming it failed with exactly this vendor error.
          // That specific write path is now fixed separately, but recovering
          // here too means any OTHER way a thread id ends up invalid degrades
          // to "start fresh with real context replayed" instead of a hard
          // failure -- the actual answer to "how do conversations resume
          // regardless of provider or account": session.messages is the
          // durable, vendor-agnostic source of truth, and nativeSessionId is
          // a disposable optimization, never a requirement.
          session.nativeSessionId = undefined;
          session.nativeStartedAt = undefined;
          turnText = failoverPrompt(session.messages ?? [], `${text}${prepared.textContext}`);
          continue;
        }
        if (failureKind !== 'quota-exhausted') throw failure;
        account.quotaState = 'exhausted';
        account.quotaRetryAt = undefined;
        await writeState(state);
        // Same-provider failover for the native-CLI path: switching accounts means
        // switching vendor config roots, so the in-flight native conversation can't
        // continue under the old identity — start a fresh one under the fallback.
        const fallback = session.accountFailover === 'on-quota-exhausted'
          ? state.accounts.find((item) => item.id !== account!.id && item.provider === account!.provider
              && item.authKind === 'vendor-cli' && item.status === 'ready' && item.quotaState !== 'exhausted')
          : undefined;
        if (!fallback) {
          throw new Error(`${harness.displayName}: ${result.text}. Switch providers with /provider or choose another ${harness.command} account with /accounts use <label>.`);
        }
        switchedFrom = account.label;
        // Announced before the retry, not after it returns: switching accounts
        // happens inside one continuous await chain, so without this the whole
        // thing looks instantaneous and the reply just silently comes from a
        // different account with nothing to explain the (brief) extra wait.
        activeFullScreenHarness?.activity(`${chalk.yellow('quota reached')} ${chalk.dim(`${switchedFrom} → ${fallback.label}, retrying…`)}`);
        activeFullScreenHarness?.phase(`retrying on ${fallback.label}`);
        account = fallback;
        session.accountId = fallback.id;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
        turnText = failoverPrompt(session.messages ?? [], `${text}${prepared.textContext}`);
        continue;
      }
      session.nativeStartedAt ??= new Date().toISOString();
      const invocation = {
        id: randomUUID(), accountId: account.id, provider: harness.provider, model: model ?? 'provider-default',
        at: new Date().toISOString(), latencyMs: Date.now() - startedAt,
      };
      state.invocations.push(invocation);
      session.messages = [...(session.messages ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: result.text }];
      session.name ??= conversationTitle(text);
      session.attachments = [];
      session.updatedAt = new Date().toISOString();
      // The vendor subprocess owns persistence. Re-read its transcript after
      // exit so any source-side turns/events that were not represented by the
      // final response are reflected in ClikCode before the turn is saved.
      await synchronizeNativeTranscript(state, session);
      await writeState(state);
      if (!activeFullScreenHarness) emitHarnessOutput({ session, text: result.text, usage: { attributedBy: harness.command }, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
      return;
    }
  }

  if (prepared.images.length) throw new Error('Image attachments currently require a vendor-CLI Codex account. Switch with /codex or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const invoke = (active: AiHarnessAccount) => streamLocalAiTurn({
    provider: session.provider ?? active.provider, model, apiKey: localApiKey(active), credentialSource: 'env',
    messages: [...(session.messages ?? []), { role: 'user', content: turnText }], reasoningEffort: session.effort as never,
    ...(signal ? { abortSignal: signal } : {}),
  });
  let turn;
  let switchedFrom: string | undefined;
  try {
    turn = await invoke(account);
  } catch (error) {
    const failureKind = classifyAccountFailure(error);
    if (failureKind === 'authentication-required') {
      account.status = 'needs_login';
      await writeState(state);
    }
    if (session.accountFailover !== 'on-quota-exhausted' || failureKind !== 'quota-exhausted') throw error;
    const exhaustedAccount = account;
    if (!exhaustedAccount) throw error;
    exhaustedAccount.quotaState = 'exhausted';
    exhaustedAccount.quotaRetryAt = undefined;
    // Preserve the quota signal even if there is no alternate account or its
    // retry fails. It is a local scheduling fact, never a provider secret.
    await writeState(state);
    const fallback = state.accounts.find((item) =>
      item.id !== exhaustedAccount.id && item.provider === exhaustedAccount.provider && item.status === 'ready' && item.quotaState !== 'exhausted'
      && item.authKind === 'api-key' && item.models.includes(model),
    );
    if (!fallback) throw error;
    switchedFrom = exhaustedAccount.id;
    activeFullScreenHarness?.activity(`${chalk.yellow('quota reached')} ${chalk.dim(`${exhaustedAccount.label} → ${fallback.label}, retrying…`)}`);
    activeFullScreenHarness?.phase(`retrying on ${fallback.label}`);
    turn = await invoke(fallback);
    account = fallback;
    session.accountId = fallback.id;
  }
  const invocation = {
    id: randomUUID(), accountId: account.id, provider: session.provider ?? account.provider, model,
    at: new Date().toISOString(), inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt,
  };
  if (activeFullScreenHarness && Array.isArray(turn.toolCalls)) {
    for (const call of turn.toolCalls) {
      const name = call && typeof call.name === 'string' ? call.name : 'tool';
      activeFullScreenHarness.activity(`${chalk.green('done')} ${chalk.dim(name)}`);
    }
  }
  state.invocations.push(invocation);
  session.messages = [...(session.messages ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: turn.text }];
  session.name ??= conversationTitle(text);
  session.attachments = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  if (!activeFullScreenHarness) emitHarnessOutput({ session, text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: 'quota-exhausted' } : {}) });
}

/** Send a gateway session through the existing authenticated platform assistant stream. */
export async function aiGatewaySessionSend(config: Conf, id: string, prompt: string, signal?: AbortSignal): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route !== 'gateway') return aiSessionSend(id, prompt, signal);
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  if (prepared.images.length) throw new Error('Image attachments currently require the local Codex provider. Switch with /codex or clear them with /attachments clear.');
  const turnText = `${text}${prepared.textContext}`;
  const baseUrl = ApiClient.getApiUrl(config).replace(/\/$/, '');
  const apiKey = ApiClient.getApiKeyForUrl(config, baseUrl);
  if (!apiKey) throw new Error(`ClikDeploy Gateway is not connected; run \`${harnessCommand()} gateway login\` first`);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ message: turnText, messages: session.messages ?? [], mode: 'plan' }),
  });
  if (!response.ok || !response.body) throw new Error(`gateway AI request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  const streamToTerminal = !isJsonDefaultMode() && !activeFullScreenHarness;
  let wroteDelta = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; label?: string; kind?: 'thinking' | 'tool-start'; tool?: string };
        if (event.type === 'delta' && typeof event.text === 'string') {
          activeFullScreenHarness?.phase('generating response');
          activeFullScreenHarness?.response(event.text, 'append');
          reply += event.text;
          if (streamToTerminal) { output.write(event.text); wroteDelta = true; }
        }
        // `kind`/`tool` are real, additive fields on the wire protocol
        // (apps/web's chat-stream.ts / assistant/chat route) mapping the
        // backend's own `{ status: 'thinking' }` / `{ status: 'tool_call',
        // tool }` into the same canonical shape native harnesses' own
        // parsers produce, so a Gateway tool call's *activity log line*
        // renders identically to a Codex or Claude Code one — same glyph,
        // same color, same bare-subject wording (renderActivityLine adds its
        // own verb, so the canonical label here is the bare tool name via
        // `tool`, not the backend's already-verbed `label`). The phase
        // (spinner text) uses `label` directly instead, since the backend's
        // phrasing ("Restarting the app…") is already the ideal spinner
        // text and renderActivityPhase's own "running X" wording is for
        // bare native-harness tool names, not a pre-verbed phrase. There's
        // no 'tool-done' here because AssistantChatEvent has no completion
        // signal to report (verified: 'tool_call' fires once, nothing after
        // it) — a real gap in what the agent loop reports, not something to
        // fake here.
        if (event.type === 'status' && typeof event.label === 'string') {
          activeFullScreenHarness?.phase(event.label);
          if (!isJsonDefaultMode()) {
            const activityEvent: HarnessActivityEvent = { kind: event.kind === 'tool-start' ? 'tool-start' : 'thinking', label: event.tool ?? event.label };
            if (activeFullScreenHarness) activeFullScreenHarness.activityEvent(activityEvent);
          }
        }
        if (event.type === 'error') throw new Error(event.error ?? 'gateway AI request failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (!reply) throw new Error('gateway AI response contained no text');
  const invocation = { id: randomUUID(), accountId: 'gateway', provider: session.provider ?? 'clikdeploy-gateway', model: session.model ?? 'platform', at: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  state.invocations.push(invocation);
  session.messages = [...(session.messages ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }];
  session.name ??= conversationTitle(text);
  session.attachments = [];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  if (wroteDelta) output.write('\n\n');
  else if (!activeFullScreenHarness) emitHarnessOutput({ session, text: reply, usage: { attributedBy: 'clikdeploy-gateway' }, invocation });
}

export async function aiSessionSet(id: string, options: { route?: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; permissions?: AiHarnessPermissionMode; accountFailover?: 'never' | 'on-quota-exhausted'; nativeSession?: string }): Promise<void> {
  if (options.route !== undefined && options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  if (options.permissions !== undefined && !VALID_PERMISSION_MODES.includes(options.permissions)) throw new Error('permissions must be ask, bypass, or auto');
  const state = await readState();
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`AI session "${id}" was not found`);
  const current = state.sessions[index];
  const effectiveRoute = options.route ?? current.route;
  if (options.permissions && effectiveRoute === 'gateway') {
    throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy; Ask, Bypass, and Auto apply only to local harnesses.');
  }
  if (effectiveRoute === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover || options.nativeSession)) {
    throw new Error('Gateway account, provider, model, effort, failover, and native sessions are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  const account = options.account === undefined
    ? undefined
    : state.accounts.find((item) => item.id === options.account || item.label === options.account);
  if (options.account !== undefined && !account) throw new Error(`local AI account "${options.account}" was not found`);
  if (account && options.provider && options.provider !== account.provider) {
    throw new Error(`account "${account.label}" belongs to ${account.provider}, not ${options.provider}`);
  }
  if (!account && options.provider && current.accountId) {
    const currentAccount = state.accounts.find((item) => item.id === current.accountId);
    if (currentAccount && currentAccount.provider !== options.provider) {
      throw new Error(`account "${currentAccount.label}" belongs to ${currentAccount.provider}; select a matching account when changing provider`);
    }
  }
  if (options.nativeSession !== undefined) {
    if (!current.nativeHarness) throw new Error('launch a native harness for this ClikCode session before attaching its native session id');
    const harness = localHarnessForCommand(current.nativeHarness);
    if (!harness?.session?.resumeIdPrefix) throw new Error(`${harness?.displayName ?? current.nativeHarness} does not declare exact native-session resume support`);
    if (!options.nativeSession.trim()) throw new Error('native session id cannot be empty');
  }
  const selectedHarness = account
    ? localHarnessForProvider(account.provider)
    : options.provider
      ? localHarnessForProvider(options.provider)
      : current.nativeHarness ? localHarnessForCommand(current.nativeHarness) : undefined;
  if (effectiveRoute === 'local' && (options.account || options.provider) && !selectedHarness) {
    throw new Error(`unknown local provider "${options.provider ?? account?.provider}"`);
  }
  if (options.model && selectedHarness && !selectedHarness.modelArgvPrefix) {
    throw new Error(`${selectedHarness.displayName} does not publish a model selector.`);
  }
  if (options.effort && selectedHarness) {
    const effortOption = optionForHarness(selectedHarness, 'effort');
    if (!effortOption) throw new Error(`${selectedHarness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  if (options.permissions && (!selectedHarness || !harnessSupportsPermissionMode(selectedHarness, options.permissions))) {
    if (!selectedHarness) throw new Error('Choose a provider before setting permissions.');
    throw new Error(`${selectedHarness.displayName} does not support ${options.permissions} permissions.`);
  }
  const base: HarnessSession = { ...current };
  if (options.route === 'local' && current.route === 'gateway') applyFreshLocalSessionPolicy(state, base);
  const next: HarnessSession = {
    ...base,
    ...(options.route ? { route: options.route } : {}),
    ...(account ? { accountId: account.id, provider: options.provider ?? account.provider } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissions ? { permissionMode: options.permissions } : {}),
    ...(options.accountFailover ? { accountFailover: options.accountFailover } : {}),
    ...(options.nativeSession !== undefined ? { nativeSessionId: options.nativeSession.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (effectiveRoute === 'gateway') applyGatewaySessionPolicy(next);
  else if (account) {
    if (account.authKind === 'vendor-cli' && selectedHarness?.turn) {
      if (next.nativeHarness !== selectedHarness.command || current.accountId !== account.id) {
        next.nativeSessionId = undefined;
        next.nativeStartedAt = undefined;
      }
      next.nativeHarness = selectedHarness.command;
    } else {
      delete next.nativeHarness;
      delete next.nativeSessionId;
      delete next.nativeStartedAt;
    }
  }
  state.sessions[index] = next;
  await writeState(state);
  emitJson({ session: next });
}
