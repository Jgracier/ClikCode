/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
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

const HARNESS_STATE_VERSION = 1;
const LOCAL_HARNESS_PROTOCOL = 1;

type AiHarnessRoute = 'local' | 'gateway';
type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';
type AiHarnessPermissionMode = 'read-only' | 'workspace-write' | 'auto';
type AiHarnessOptionKind = 'boolean' | 'string' | 'enum' | 'string-list' | 'path' | 'path-list' | 'number';
interface AiHarnessOptionDefinition {
  id: string; label: string; description: string; category: string; kind: AiHarnessOptionKind;
  values?: readonly string[]; dangerous?: boolean; requiresNewSession?: boolean;
}
interface AiHarnessCapabilityManifest {
  options: readonly AiHarnessOptionDefinition[];
  managers?: Readonly<Partial<Record<'mcp' | 'skills' | 'plugins' | 'agents' | 'hooks' | 'tools', { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] }>>>;
  features?: readonly string[];
}
interface AiHarnessAccount {
  id: string;
  provider: string;
  label: string;
  authKind: AiHarnessAuthKind;
  models: string[];
  status: 'ready' | 'needs_login' | 'offline';
  quotaState?: 'available' | 'exhausted';
  quotaRetryAt?: string;
  credentialRef: string;
  nativeProfile?: { env: string; path: string };
}
interface AiLocalHarnessDefinition {
  command: string;
  provider: string;
  displayName: string;
  surface: 'terminal' | 'editor-extension';
  localAuth: readonly AiHarnessAuthKind[];
  binary: string;
  npmPackage?: string;
  loginArgv?: readonly string[];
  statusArgv?: readonly string[];
  logoutArgv?: readonly string[];
  versionArgv?: readonly string[];
  launchArgv?: readonly string[];
  modelArgvPrefix?: readonly string[];
  modelDiscoveryArgv?: readonly string[];
  workspaceArgvPrefix?: readonly string[];
  effortArgvPrefix?: readonly string[];
  effortConfigKey?: string;
  permissionModes?: readonly AiHarnessPermissionMode[];
  profileEnv?: string;
  turn?: {
    startArgv: readonly string[];
    resumeArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    promptArgvPrefix?: readonly string[];
    promptInput?: 'argv' | 'stdin';
    output: 'text' | 'json' | 'json-lines';
    responseFields?: readonly string[];
    resumeSupportsWorkspaceSelector?: boolean;
  };
  session?: {
    continueArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    createSessionArgv?: readonly string[];
    idKind?: 'uuid' | 'history-file';
    discoverArgv?: readonly string[];
    discoverFormat?: 'json' | 'json-lines' | 'text';
  };
}
interface AiRouterRuntime {
  streamAiChatTurn(input: Record<string, unknown>): Promise<any>;
  AI_LOCAL_HARNESS_ADAPTER_VERSION: number;
  AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[];
  localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined;
  localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined;
  localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest;
  harnessSupportsEffort(harness: AiLocalHarnessDefinition): boolean;
  harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean;
  harnessSupportsImages(harness: AiLocalHarnessDefinition): boolean;
  nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: {
    prompt: string; nativeSessionId?: string; createdHere?: boolean; launchedBefore?: boolean;
    model?: string | null; workspace?: string | null; effort?: string | null;
    permissionMode?: AiHarnessPermissionMode;
    images?: readonly string[];
    options?: Readonly<Record<string, unknown>>;
  }): string[];
}

const require = createRequire(import.meta.url);
let routerRuntime: AiRouterRuntime | undefined;
function localRouter(): AiRouterRuntime {
  if (!routerRuntime) {
    try {
      // Normal clikdeploy-cli layout: dist/commands/ai.js → dist runtime.
      routerRuntime = require('../ai-router-runtime.cjs') as AiRouterRuntime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
      // Standalone ClikCode bundle: dist/index.js → sibling runtime.
      routerRuntime = require(fileURLToPath(new URL('./ai-router-runtime.cjs', import.meta.url))) as AiRouterRuntime;
    }
  }
  return routerRuntime;
}
function localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined {
  return localRouter().localHarnessForCommand(command);
}
function localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined {
  return localRouter().localHarnessForProvider(provider);
}
function localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest {
  return localRouter().localHarnessCapabilityManifest(harness);
}
function harnessSupportsEffort(harness: AiLocalHarnessDefinition): boolean {
  return localRouter().harnessSupportsEffort(harness);
}
function harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean {
  return localRouter().harnessSupportsPermissionMode(harness, mode);
}
function harnessSupportsImages(harness: AiLocalHarnessDefinition): boolean {
  return localRouter().harnessSupportsImages(harness);
}
function streamLocalAiTurn(input: Record<string, unknown>): Promise<any> {
  return localRouter().streamAiChatTurn(input);
}

function nativeSessionIds(outputText: string, format: 'json' | 'json-lines' | 'text' = 'text'): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:id|session_?id|thread_?id|chat_?id|session)$/i.test(key) && typeof child === 'string' && child.trim()) ids.add(child.trim());
      else visit(child);
    }
  };
  try {
    if (format === 'json') visit(JSON.parse(outputText));
    else if (format === 'json-lines') {
      for (const line of outputText.split(/\r?\n/).filter(Boolean)) visit(JSON.parse(line));
    }
  } catch {
    // A vendor changing its documented JSON shape must not make us attach a
    // guessed session. The stable textual identifiers below are still safe.
  }
  for (const match of outputText.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi)) ids.add(match[0]);
  return ids;
}

function nativeTurnResult(harness: AiLocalHarnessDefinition, stdout: string): { text: string; nativeSessionId?: string; isError?: boolean; statusCode?: number } {
  if (!harness.turn) throw new Error(`${harness.displayName} has no centralized turn adapter`);
  if (harness.turn.output === 'text') {
    const text = stdout.trim();
    if (!text) throw new Error(`${harness.displayName} returned no assistant text`);
    const nativeSessionId = /(?:session|thread|chat)(?:\s+id)?\s*[:=]\s*([\w-]{8,})/i.exec(stdout)?.[1];
    return { text, ...(nativeSessionId ? { nativeSessionId } : {}) };
  }
  const values: unknown[] = [];
  try {
    if (harness.turn.output === 'json') values.push(JSON.parse(stdout));
    else for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) values.push(JSON.parse(line));
  } catch (error) {
    throw new Error(`${harness.displayName} returned invalid ${harness.turn.output} output: ${(error as Error).message}`);
  }
  const fields = new Set(harness.turn.responseFields ?? ['result', 'response', 'text', 'content']);
  const messages: string[] = [];
  let isError = false;
  let statusCode: number | undefined;
  const visit = (value: unknown, parentType?: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentType));
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : parentType;
    if (record.is_error === true || record.error === true) isError = true;
    if (typeof record.api_error_status === 'number') statusCode = record.api_error_status;
    else if (typeof record.status === 'number' && record.status >= 400) statusCode = record.status;
    for (const [key, child] of Object.entries(record)) {
      if (fields.has(key) && typeof child === 'string' && child.trim()) {
        // JSON event streams often contain tool input and user echoes. Only
        // accept generic text/content from assistant/result-shaped events.
        if (!['text', 'content'].includes(key) || !type || /assistant|agent|message|result|complete|text/i.test(type)) messages.push(child.trim());
      } else visit(child, type);
    }
  };
  values.forEach((value) => visit(value));
  const text = messages[messages.length - 1]?.trim();
  if (!text) throw new Error(`${harness.displayName} returned no assistant text in its structured output`);
  const ids = nativeSessionIds(stdout, harness.turn.output);
  return { text, nativeSessionId: [...ids][0], ...(isError ? { isError } : {}), ...(statusCode ? { statusCode } : {}) };
}

/** Render provider JSONL as a small provider-neutral activity stream. */
function nativeActivityLine(harness: AiLocalHarnessDefinition, lineText: string): string | undefined {
  if (isJsonDefaultMode()) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    // fail-open-ok: plain-text harness output has no structured activity metadata to render.
    return undefined;
  }
  const type = String(value.type ?? '');
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  const reasoningSummary = (candidate: unknown): string | undefined => {
    if (typeof candidate === 'string') return candidate.trim() || undefined;
    if (!Array.isArray(candidate)) return undefined;
    const text = candidate.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return [String((part as Record<string, unknown>).text)];
      return [];
    }).join(' ').trim();
    return text || undefined;
  };
  if (type === 'thread.started' || type === 'turn.started') return undefined;
  if (/reasoning|thinking/.test(itemType) && /completed|done/.test(type)) {
    const summary = reasoningSummary(item?.summary) ?? reasoningSummary(item?.text) ?? reasoningSummary(item?.content);
    return summary ? `  ${chalk.cyan('thinking')} ${chalk.dim(visibleSlice(summary.replace(/\s+/g, ' '), 140))}` : undefined;
  }
  if (/command_execution/.test(itemType) && /started|completed/.test(type)) {
    const command = String(item?.command ?? item?.command_line ?? '').trim();
    const state = type.endsWith('completed') ? chalk.green('done') : chalk.yellow('run');
    return command ? `  ${state} ${chalk.dim(command)}` : undefined;
  }
  if (/file_change/.test(itemType) && /completed/.test(type)) return `  ${chalk.green('edit')} ${chalk.dim('files updated')}`;
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.name ?? item?.server ?? 'tool');
    return `  ${type.endsWith('completed') ? chalk.green('done') : chalk.yellow('tool')} ${chalk.dim(name)}`;
  }
  if (harness.command === 'claude') {
    if (type === 'system' && value.subtype === 'init') return undefined;
    if (type === 'assistant') {
      const message = value.message as { content?: Array<Record<string, unknown>> } | undefined;
      const tool = message?.content?.find((part) => part.type === 'tool_use');
      if (tool) return `  ${chalk.yellow('tool')} ${chalk.dim(String(tool.name ?? 'tool'))}`;
    }
  }
  return undefined;
}

function nativeActivityPhase(lineText: string): 'generating response' | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    // fail-open-ok: non-JSON output is ordinary assistant text, not a structured result envelope.
    return undefined;
  }
  const type = String(value.type ?? '');
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  if (/assistant|agent_message/.test(itemType) && /started|delta|completed/.test(type)) return 'generating response';
  if (type === 'assistant') return 'generating response';
  return undefined;
}

/**
 * Claude Code's `--model` aliases are deliberately version-less — they always
 * track whatever Anthropic currently ships for that tier, so passing the bare
 * alias (not a dated id) is the correct, future-proof argv value. That leaves
 * the alias alone unreadable in a picker ("sonnet" looks stale next to
 * "Sonnet 5"), so this is display-only: which concrete generation each alias
 * currently resolves to, verified against a real `claude --model <alias>
 * --output-format stream-json` run's `system.init.model` field. Update when
 * Anthropic ships a new tier — same manual-maintenance shape as the Copilot
 * model list a few lines below.
 */
const CLAUDE_ALIAS_LABELS: Readonly<Record<string, string>> = {
  fable: 'Fable 5.1', opus: 'Opus 5', sonnet: 'Sonnet 5', haiku: 'Haiku 4.5',
};

async function nativeModelCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<{ configured?: string; models: string[]; labels?: Readonly<Record<string, string>> }> {
  const models = new Set(account?.models ?? []);
  const addDiscoveredModels = (raw: string): void => {
    const add = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const model = value.trim();
      if (/^[a-z0-9][a-z0-9._:/-]{1,127}$/i.test(model)) models.add(model);
    };
    try {
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (/^(?:id|model|modelId|slug)$/i.test(key)) add(child);
          else visit(child);
        }
      };
      visit(JSON.parse(raw));
    } catch {
      for (const line of raw.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
        const clean = line.trim().replace(/^[•*✓✔❯>\-]+\s*/, '');
        if (!clean) continue;
        const token = clean.split(/\s+/, 1)[0]?.replace(/^['"`]|['"`,:]$/g, '');
        if (token && (clean === token || /[\/.\d:_-]/.test(token))) add(token);
      }
    }
  };
  const profileRoot = account?.nativeProfile?.path
    ?? (harness.profileEnv ? process.env[harness.profileEnv]?.trim() : undefined)
    ?? (harness.command === 'codex' ? join(homedir(), '.codex')
      : harness.command === 'claude' ? join(homedir(), '.claude')
        : harness.command === 'gemini' ? join(homedir(), '.gemini') : undefined);
  let configured: string | undefined;
  if (profileRoot && harness.command === 'codex') {
    try {
      const config = await readFile(join(profileRoot, 'config.toml'), 'utf8');
      configured = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    } catch { /* Codex will choose its own default when no config exists. */ }
    try {
      const cache = JSON.parse(await readFile(join(profileRoot, 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
      for (const model of cache.models ?? []) {
        if (typeof model.slug === 'string' && model.slug.trim() && model.visibility !== 'hide') models.add(model.slug.trim());
      }
    } catch { /* The cache is optional and vendor-owned. */ }
  } else if (profileRoot && harness.command === 'claude') {
    try {
      const settings = JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as { model?: unknown };
      if (typeof settings.model === 'string' && settings.model.trim()) configured = settings.model.trim();
    } catch { /* Claude will choose its own default when no setting exists. */ }
    ['fable', 'opus', 'sonnet', 'haiku'].forEach((model) => models.add(model));
  } else if (profileRoot && harness.command === 'gemini') {
    try {
      const settings = JSON.parse(await readFile(join(profileRoot, 'settings.json'), 'utf8')) as { model?: unknown; selectedModel?: unknown };
      const value = typeof settings.model === 'string' ? settings.model : settings.selectedModel;
      if (typeof value === 'string' && value.trim()) configured = value.trim();
    } catch { /* Gemini will choose its own default when no setting exists. */ }
    ['auto', 'pro', 'flash', 'flash-lite'].forEach((model) => models.add(model));
  }
  if (harness.command === 'copilot') {
    ['auto', 'claude-sonnet-4.6', 'gpt-5.4', 'gpt-6-astra', 'claude-haiku-4.5', 'gpt-5.3-codex', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash'].forEach((model) => models.add(model));
  }
  if (harness.modelDiscoveryArgv) {
    const environment = account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
    try {
      addDiscoveredModels(await captureNativeHarnessOutput(harness, harness.modelDiscoveryArgv, environment, 12_000));
    } catch { /* Keep configured/account models and the custom-ID option available. */ }
  }
  if (configured) models.add(configured);
  return {
    ...(configured ? { configured } : {}),
    models: [...models],
    ...(harness.command === 'claude' ? { labels: CLAUDE_ALIAS_LABELS } : {}),
  };
}

const nativeUsageCache = new Map<string, { at: number; label?: string }>();

/** Per-harness live usage probe. Each vendor CLI exposes quota/cost through a different
 * surface (or none at all); adding a harness here is the only step needed to light up
 * its usage footer, everything else (caching, dispatch, rendering) is shared. */
type NativeUsageProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<string | undefined>;

function formatTokenCount(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
  return String(total);
}

/** Parse just the `info` object out of `opencode export <id>` without waiting for (or
 * buffering) the full transcript, which can be arbitrarily large and isn't needed here. */
async function captureOpencodeSessionSummary(sessionId: string): Promise<{ cost: number; tokens: { input: number; output: number } } | undefined> {
  return new Promise((resolveSummary) => {
    const child = spawn('opencode', ['export', sessionId], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (value?: { cost: number; tokens: { input: number; output: number } }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolveSummary(value);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      // `info` is written first, but a single `data` event can already carry far more
      // than that object (a pipe delivers whatever the child buffered before its first
      // flush) — search what's arrived before giving up, don't discard it unread.
      const infoStart = buffer.indexOf('"info"');
      if (infoStart === -1) return buffer.length > 16 * 1024 ? finish() : undefined;
      const braceStart = buffer.indexOf('{', infoStart);
      if (braceStart === -1) return;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = braceStart; index < buffer.length; index++) {
        const character = buffer[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') depth++;
        else if (character === '}') {
          depth--;
          if (depth === 0) {
            try {
              const info = JSON.parse(buffer.slice(braceStart, index + 1)) as { cost?: number; tokens?: { input?: number; output?: number } };
              return finish({ cost: typeof info.cost === 'number' ? info.cost : 0, tokens: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0 } });
            } catch {
              // fail-open-ok: an incomplete stream fragment carries no usable response payload.
              return finish();
            }
          }
        }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
}

async function opencodeUsageProbe(session: HarnessSession): Promise<string | undefined> {
  if (!session.nativeSessionId) return undefined;
  const summary = await captureOpencodeSessionSummary(session.nativeSessionId);
  if (!summary) return undefined;
  const total = summary.tokens.input + summary.tokens.output;
  if (!total) return undefined;
  const tokenLabel = `${formatTokenCount(total)} tok`;
  return summary.cost > 0 ? `${tokenLabel} · $${summary.cost.toFixed(2)}` : tokenLabel;
}

async function codexUsageProbe(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  const response = await new Promise<Record<string, unknown> | undefined>((resolveUsage) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment },
    });
    let buffer = '';
    let settled = false;
    let initialized = false;
    const finish = (value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolveUsage(value);
    };
    const send = (message: Record<string, unknown>): void => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (message.id === 1 && message.result && typeof message.result === 'object') {
            if (initialized) return;
            initialized = true;
            // The rate-limits read answers only after the initialize handshake has
            // settled; give the transport a moment before asking, and leave stdin
            // open so the response can come back.
            const ask = setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }), 250);
            ask.unref();
          } else if (message.id === 2 && message.result && typeof message.result === 'object') {
            return finish(message.result as Record<string, unknown>);
          }
        } catch { /* Ignore logs and unrelated notifications. */ }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clikcode', version: '1.0.34' } } });
    send({ method: 'initialized', params: {} });
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
  const snapshot = response?.rateLimits && typeof response.rateLimits === 'object'
    ? response.rateLimits as Record<string, unknown> : undefined;
  const windows = [snapshot?.primary, snapshot?.secondary].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  const parts = windows.flatMap((window) => {
    const used = typeof window.usedPercent === 'number' ? window.usedPercent : undefined;
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined;
    if (used === undefined || minutes === undefined) return [];
    const period = minutes === 300 ? '5h' : minutes === 10_080 ? 'week' : minutes < 1_440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1_440)}d`;
    return [`${period} ${Math.max(0, Math.min(100, 100 - used))}% left`];
  });
  return parts.length ? parts.join(' · ') : undefined;
}

const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageProbe>>> = {
  codex: codexUsageProbe,
  opencode: opencodeUsageProbe,
};

async function nativeUsageLabel(session: HarnessSession, state: HarnessState): Promise<string | undefined> {
  const probe = session.nativeHarness ? NATIVE_USAGE_PROBES[session.nativeHarness] : undefined;
  if (!probe) return undefined;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const cacheKey = `${session.nativeHarness}:${account?.nativeProfile?.path ?? session.nativeSessionId ?? 'default'}`;
  const cached = nativeUsageCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.label;
  const environment = account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
  const label = await probe(session, environment).catch(() => undefined);
  nativeUsageCache.set(cacheKey, { at: Date.now(), ...(label ? { label } : {}) });
  return label;
}

/** Usage is probed per-session above (it needs a native session id for OpenCode);
 * an account has no session of its own, so borrow one of its sessions if it has
 * any, or a bare stand-in otherwise — codexUsageProbe ignores the session
 * argument entirely, and a stand-in with no nativeSessionId simply yields no
 * OpenCode label rather than a wrong one. */
async function accountUsageLabel(account: AiHarnessAccount, state: HarnessState): Promise<string | undefined> {
  if (account.authKind !== 'vendor-cli') return undefined;
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !NATIVE_USAGE_PROBES[harness.command]) return undefined;
  const related = state.sessions.find((item) => item.accountId === account.id && item.nativeSessionId);
  const pseudoSession: HarnessSession = related ?? {
    id: `account:${account.id}`, route: 'local', accountId: account.id, provider: account.provider,
    model: null, effort: 'medium', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active',
    nativeHarness: harness.command,
  };
  return nativeUsageLabel(pseudoSession, state);
}

interface HarnessSession {
  id: string;
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  effort: string;
  permissionMode?: AiHarnessPermissionMode;
  name?: string;
  accountFailover: 'never' | 'on-quota-exhausted';
  createdAt: string;
  updatedAt: string;
  /** A closed chat is retained for history but is never reopened implicitly. */
  status: 'active' | 'closed' | 'archived';
  closedAt?: string;
  /** Native agent identity, owned by the selected vendor CLI and never sent to Gateway. */
  nativeHarness?: string;
  nativeSessionId?: string;
  nativeStartedAt?: string;
  workspace?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  attachments?: string[];
  /** Provider-native values validated against the selected harness manifest. */
  harnessOptions?: Record<string, unknown>;
}

/** Defaults a brand-new session is built from. Provider-specific overrides win
 * over the global defaults, which win over the hardcoded fallback — replacing
 * the old behavior of silently copying whatever the previous session happened
 * to have (a one-off read-only session would otherwise make the *next* new
 * chat read-only too, with no setting anywhere explaining why). */
interface HarnessDefaultSettings {
  effort: string;
  permissionMode: AiHarnessPermissionMode;
  accountFailover: 'never' | 'on-quota-exhausted';
}

const HARNESS_DEFAULT_SETTINGS: HarnessDefaultSettings = { effort: 'medium', permissionMode: 'workspace-write', accountFailover: 'on-quota-exhausted' };

interface HarnessState {
  version: number;
  installationId: string;
  /** Bearer secret for the loopback protocol; never rendered by CLI commands or HTTP responses. */
  localApiToken: string;
  /** Device-authentication keypair, never a provider credential. Private half stays local. */
  devicePrivateKeyPem: string;
  devicePublicKey: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: HarnessSession[];
  invocations: Array<{ id: string; accountId: string; provider: string; model: string; at: string; inputTokens?: number; outputTokens?: number; latencyMs: number }>;
  /** Applies to every provider unless a providerSettings entry overrides it. */
  globalSettings: HarnessDefaultSettings;
  /** Keyed by AiLocalHarnessDefinition.provider; only the fields a user has set. */
  providerSettings: Record<string, Partial<HarnessDefaultSettings & { model: string }>>;
}

function resolveDefaultSettings(state: HarnessState, provider?: string | null): HarnessDefaultSettings {
  const overrides = provider ? state.providerSettings[provider] : undefined;
  return {
    effort: overrides?.effort ?? state.globalSettings.effort,
    permissionMode: overrides?.permissionMode ?? state.globalSettings.permissionMode,
    accountFailover: overrides?.accountFailover ?? state.globalSettings.accountFailover,
  };
}

function newDeviceSigningIdentity(): Pick<HarnessState, 'devicePrivateKeyPem' | 'devicePublicKey'> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    devicePrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    devicePublicKey: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  };
}

function harnessStatePath(): string {
  // The caller may relocate non-secret state for testing or portable installs.
  // Provider tokens never live in this file; only opaque local credential refs do.
  const clikCode = process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode');
  const base = process.env.CLIKCODE_HOME?.trim()
    || process.env.CLIKDEPLOY_AI_HOME?.trim()
    || (clikCode ? join(homedir(), '.clikcode') : join(homedir(), '.clikdeploy', 'ai'));
  return join(base, 'harness-state.json');
}

function harnessCommand(): string {
  return process.argv[1]?.includes('clikcode') || process.argv[1]?.includes('index-clikcode')
    ? 'clikcode'
    : 'clikdeploy ai';
}

function compactPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function conversationTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, ' ').trim();
  return title.length > 64 ? `${title.slice(0, 63).trimEnd()}…` : title;
}

function sessionEngine(session: HarnessSession): string {
  return session.route === 'gateway' ? 'gateway' : session.nativeHarness ?? session.provider ?? 'none';
}

function sessionProviderLabel(session: HarnessSession): string {
  if (session.route === 'gateway') return 'ClikDeploy Gateway';
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  return harness?.displayName ?? session.provider ?? 'Not selected';
}

interface HarnessPrompter {
  question(prompt: string, commands?: readonly PickerOption<string>[]): Promise<string>;
  select?<T>(title: string, options: readonly PickerOption<T>[]): Promise<T | undefined>;
  render?(session: HarnessSession, account?: string, notice?: string): void;
  panel?(title: string, body: string): void;
  close(): void;
}

function visibleSlice(value: string, width: number): string {
  if (terminalCellWidth(value) <= width) return value;
  const available = Math.max(0, width - 1);
  let rendered = '';
  for (const character of value) {
    if (terminalCellWidth(rendered + character) > available) break;
    rendered += character;
  }
  return `${rendered}…`;
}

function terminalCellWidth(value: string): number {
  const plain = value.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character) || code === 0xfe0f) continue;
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
  }
  return width;
}

function previousCharacterIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const code = value.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index > 1 ? index - 2 : index - 1;
}

function nextCharacterIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length ? index + 2 : index + 1;
}

function composerViewport(value: string, cursor: number, available: number): { text: string; cursorWidth: number } {
  if (terminalCellWidth(value) <= available) return { text: value, cursorWidth: terminalCellWidth(value.slice(0, cursor)) };
  let start = 0;
  while (start < cursor && terminalCellWidth(value.slice(start, cursor)) > available - 2) start = nextCharacterIndex(value, start);
  const prefix = start > 0 ? '…' : '';
  let end = value.length;
  while (end > cursor && terminalCellWidth(prefix + value.slice(start, end)) > available) end = previousCharacterIndex(value, end);
  const suffix = end < value.length ? '…' : '';
  while (end > cursor && terminalCellWidth(prefix + value.slice(start, end) + suffix) > available) end = previousCharacterIndex(value, end);
  return { text: `${prefix}${value.slice(start, end)}${suffix}`, cursorWidth: terminalCellWidth(prefix + value.slice(start, cursor)) };
}

class FullScreenHarnessPrompter implements HarnessPrompter {
  private closed = false;
  private history: string[] = [];
  private currentSession?: HarnessSession;
  private currentAccount?: string;
  private currentNotice?: string;
  private draft = '';
  private draftOptions: readonly PickerOption<string>[] = [];
  private draftSelected = 0;
  private draftPrompt = '› ';
  private draftCursor = 0;
  private draftPalette?: { capacity?: number; hint?: string; hideCursor?: boolean };
  private waitingTimer?: NodeJS.Timeout;
  private waitingFrame = 0;
  private waitingLabel = '';
  private activityLines: string[] = [];
  private activityAnchor = 0;
  private waitingScreenRow?: number;
  private usageLabel?: string;
  private selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever draftOptions happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  private paletteActive = false;
  private cancelWaiting?: () => void;
  private waitingCancelled = false;
  private readonly onWaitingInput = (chunk: Buffer | string): void => {
    const key = String(chunk);
    if (this.waitingCancelled || (key !== '\u001b' && key !== '\u0003')) return;
    this.waitingCancelled = true;
    this.waitingLabel = 'stopping…';
    this.updateWaiting();
    this.cancelWaiting?.();
  };
  private readonly onResize = (): void => {
    if (!this.closed) {
      output.write('\u001b[2J');
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    }
  };

  constructor() {
    output.write('\u001b[?1049h\u001b[?25h');
    process.on('SIGWINCH', this.onResize);
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    this.currentSession = session;
    this.currentAccount = account;
    this.currentNotice = notice;
    this.paint('', [], 0, '› ', 0);
  }

  activity(message: string): void {
    const normalized = message.trim();
    if (!normalized || this.activityLines[this.activityLines.length - 1] === normalized) return;
    this.activityLines = [...this.activityLines.slice(-5), normalized];
    if (!this.selecting && !this.paletteActive) this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  panel(title: string, body: string): void {
    const lines = body.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.activityLines = [chalk.bold(title), ...lines].slice(-6);
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  startWaiting(message: string, onCancel?: () => void): void {
    this.stopWaiting(false);
    this.activityLines = [];
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    this.waitingLabel = message;
    this.cancelWaiting = onCancel;
    this.waitingCancelled = false;
    this.waitingFrame = 0;
    if (input.isTTY) {
      input.setRawMode(true);
      input.resume();
      input.on('data', this.onWaitingInput);
    }
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
    this.waitingTimer = setInterval(() => {
      this.waitingFrame++;
      this.updateWaiting();
    }, 90);
    this.waitingTimer.unref();
  }

  stopWaiting(refresh = true): void {
    if (this.waitingTimer) clearInterval(this.waitingTimer);
    this.waitingTimer = undefined;
    input.off('data', this.onWaitingInput);
    if (input.isTTY) input.setRawMode(false);
    this.cancelWaiting = undefined;
    this.waitingCancelled = false;
    this.waitingLabel = '';
    this.waitingScreenRow = undefined;
    if (refresh && !this.closed) this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  phase(message: string): void {
    if (!this.waitingLabel || this.waitingCancelled || this.waitingLabel === message) return;
    this.waitingLabel = message;
    this.updateWaiting();
  }

  usage(label?: string): void {
    if (this.usageLabel === label) return;
    this.usageLabel = label;
    if (!this.selecting && !this.paletteActive) this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  private statusText(): string {
    const session = this.currentSession;
    if (!session) return '';
    const context = compactPath(session.workspace ?? process.cwd());
    const provider = `${sessionProviderLabel(session)}${this.usageLabel ? `  ${this.usageLabel}` : ''}`;
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    const rawModel = harness?.modelArgvPrefix ? session.model ?? 'automatic' : undefined;
    const model = rawModel && harness?.command === 'claude' ? CLAUDE_ALIAS_LABELS[rawModel] ?? rawModel : rawModel;
    const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
    // The only other place a chat's title ever appeared was a transient line in the
    // /resume picker itself — once you were actually inside a resumed conversation
    // there was nothing on screen confirming which one, so switching looked like it
    // hadn't done anything even when the transcript above had in fact changed.
    const title = session.name ? `“${session.name}”` : undefined;
    return [provider, title, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  private waitingText(): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    return `${frames[this.waitingFrame % frames.length]} ${this.waitingLabel}`;
  }

  private updateWaiting(): void {
    if (!this.waitingLabel || !this.waitingScreenRow) return;
    const width = Math.max(12, (output.columns || 100) - 1);
    // Hiding the cursor for this one write keeps it from visibly jumping to the
    // activity row and back every ~90ms while the spinner ticks.
    output.write(`\u001b[?25l\u001b7\u001b[${this.waitingScreenRow};1H\u001b[2K  ${chalk.cyan('●')} ${chalk.dim(visibleSlice(this.waitingText(), width - 6))}\u001b8\u001b[?25h`);
  }

  /** `palette` fixes the reserved footer band to `capacity` rows for the whole time a
   * palette is open (instead of resizing per keystroke as matches narrow), and
   * `footerOnly` skips repainting the conversation area above it. Together these turn
   * "retype the whole screen on every keystroke" into "rewrite only what changed",
   * which is what stopped the palette from visibly flickering/jumping as you type.
   * The whole frame is assembled into one string and written with a single syscall,
   * with the terminal cursor hidden for the duration: the previous per-line writes
   * let the terminal actually render the cursor mid-hop between rows on every paint,
   * which is what "cursor glitches all over the place" was — not a logic bug, a
   * rendering-granularity one. `select()` reuses this same path (see below) so a
   * provider/model/effort picker is a windowed slice of this palette block, anchored
   * next to the composer, instead of a separate full-screen takeover. */
  private paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: { capacity?: number; footerOnly?: boolean; hint?: string; hideCursor?: boolean }): void {
    const session = this.currentSession;
    if (!session) return;
    this.draft = composer;
    this.draftOptions = options;
    this.draftSelected = selected;
    this.draftPrompt = prompt;
    this.draftCursor = cursor;
    this.draftPalette = palette ? { capacity: palette.capacity, hint: palette.hint, hideCursor: palette.hideCursor } : undefined;
    const width = Math.max(12, (output.columns || 100) - 1);
    const inner = width - 4;
    const rule = chalk.dim('─'.repeat(width));
    const allMessages = session.messages ?? [];
    const messages = allMessages.slice(-6);
    const messageStart = allMessages.length - messages.length;
    const targetHeight = Math.max(4, (output.rows || 30) - 1);
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    const paletteCapacity = Math.min(requestedPaletteCapacity, Math.max(0, targetHeight - 5));
    const footerOnly = palette?.footerOnly ?? false;
    const paletteRows = paletteCapacity;
    const noticeRows = this.currentNotice ? 1 : 0;
    // -2, not -1: leaves one real blank row at the bottom so the status line
    // isn't pinned flush against the terminal's last row, and keeps total
    // frame height strictly under the terminal height as a margin against
    // the exact-height scroll class of bug (see the meta-line write below).
    const rows = Math.max(1, targetHeight - 3 - paletteRows - noticeRows);
    const conversation: Array<{ text: string; waiting?: boolean }> = [];
    let activityAppended = false;
    const appendActivity = (): void => {
      if (activityAppended) return;
      activityAppended = true;
      for (const activity of this.activityLines) conversation.push({ text: `  ${chalk.dim('·')} ${activity}` });
      if (this.waitingLabel) conversation.push({ text: `  ${chalk.cyan('●')} ${chalk.dim(this.waitingText())}`, waiting: true });
    };
    for (const [messageIndex, message] of messages.entries()) {
      const marker = message.role === 'assistant' ? chalk.white('·') : chalk.white('›');
      let firstLine = true;
      for (const paragraph of message.content.split(/\r?\n/)) {
        const clean = paragraph || ' ';
        for (let offset = 0; offset < clean.length; offset += inner - 2) {
          const prefix = firstLine ? `${marker} ` : '  ';
          conversation.push({ text: `  ${prefix}${clean.slice(offset, offset + inner - 2)}` });
          firstLine = false;
        }
      }
      conversation.push({ text: '' });
      if (messageStart + messageIndex + 1 === this.activityAnchor) appendActivity();
    }
    if (!activityAppended) appendActivity();
    const shown = conversation.slice(-rows);
    const meta = this.statusText();
    // DEC autowrap must stay off while an absolute-positioned frame is written.
    // A provider-supplied label can otherwise occupy two physical terminal rows
    // while the renderer still counts one, shifting every subsequent footer-only
    // repaint and leaving stale option rows above the composer.
    let frame = '\u001b[?25l\u001b[?7l';
    const screenLine = (text = ''): void => { frame += `\r\u001b[2K${text}\n`; };
    if (footerOnly) {
      frame += `\u001b[${rows + noticeRows + 1};1H`;
    } else {
      frame += '\u001b[H';
      this.waitingScreenRow = undefined;
      if (shown.length) for (const [index, row] of shown.entries()) {
        screenLine(row.text);
        if (row.waiting) this.waitingScreenRow = index + 1;
      }
      else {
        screenLine();
        screenLine(`  ${chalk.dim('Start a conversation. Type / to open the command palette.')}`);
        screenLine();
      }
      const renderedConversationRows = shown.length || 3;
      const padding = Math.max(0, rows - renderedConversationRows);
      for (let index = 0; index < padding; index++) screenLine();
      if (this.currentNotice) screenLine(`  ${chalk.yellow(visibleSlice(this.currentNotice, inner))}`);
    }
    if (paletteCapacity) {
      screenLine(rule);
      const visibleRows = paletteCapacity - 2;
      const start = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), options.length - visibleRows));
      const windowed = options.slice(start, start + visibleRows);
      windowed.forEach((option, index) => {
        const absoluteIndex = start + index;
        const selectedOption = absoluteIndex === selected;
        const available = Math.max(1, width - 4);
        const label = visibleSlice(option.label, available);
        const remaining = available - terminalCellWidth(label);
        const detail = option.detail && remaining > 3 ? visibleSlice(option.detail, remaining - 2) : '';
        screenLine(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${detail ? `  ${chalk.dim(detail)}` : ''}`);
      });
      for (let index = windowed.length; index < visibleRows; index++) screenLine();
      screenLine(`  ${chalk.dim(visibleSlice(palette?.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
    }
    screenLine(rule);
    const viewport = composerViewport(composer, cursor, Math.max(8, inner - terminalCellWidth(prompt)));
    screenLine(`  ${chalk.white(prompt)}${viewport.text}`);
    screenLine();
    // No trailing "\n" here: total frame height is exactly the terminal height, so a
    // newline after this, its last line, would land the cursor on the last row and
    // scroll the whole screen by one -- invisible in a one-off full repaint (which
    // starts over from \u001b[H next time), but fatal for footerOnly/select()
    // repaints, which jump back to a fixed absolute row: every such scroll left that
    // target one row stale, so the old line was never overwritten, only added to --
    // the "adds a line every time you scroll" reports in the palette and pickers.
    frame += `\r\u001b[2K  ${chalk.dim(visibleSlice(meta, inner))}\u001b[?7h`;
    if (!palette?.hideCursor) frame += `\u001b[2A\r\u001b[${2 + terminalCellWidth(prompt) + viewport.cursorWidth}C\u001b[?25h`;
    output.write(frame);
  }

  question(prompt: string, commands: readonly PickerOption<string>[] = []): Promise<string> {
    if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    return new Promise((resolveQuestion) => {
      let value = '';
      let cursor = 0;
      let selected = 0;
      let historyIndex = this.history.length;
      let showedPalette = false;
      // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
      // footer band a fixed height is what stops the conversation area above it from
      // reflowing (and the cursor from jumping) as the number of matches narrows.
      const paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
      let paletteOpen = false;
      const matches = () => value.startsWith('/') && !value.includes(' ')
        ? commands.filter((option) => option.value.startsWith(value)).slice(0, 8)
        : [];
      const draw = (): void => {
        const options = matches();
        if (selected >= options.length) selected = 0;
        if (options.length || showedPalette) {
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity, footerOnly: paletteOpen });
          paletteOpen = true;
          this.paletteActive = true;
        } else {
          const available = Math.max(8, (output.columns || 100) - 5 - terminalCellWidth(prompt));
          const viewport = composerViewport(value, cursor, available);
          output.write(`\u001b[?25l\r\u001b[2K  ${chalk.white(prompt)}${viewport.text}\r\u001b[${2 + terminalCellWidth(prompt) + viewport.cursorWidth}C\u001b[?25h`);
          this.draft = value;
          this.draftOptions = [];
          this.draftSelected = selected;
          this.draftPrompt = prompt;
          this.draftCursor = cursor;
          paletteOpen = false;
          this.paletteActive = false;
        }
        showedPalette = options.length > 0;
      };
      const finish = (answer: string): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        input.off('data', onData);
        input.setRawMode(false);
        output.write('\u001b[?25h');
        if (answer && !answer.startsWith('/') && this.history[this.history.length - 1] !== answer) this.history.push(answer);
        resolveQuestion(answer);
      };
      let finished = false;
      const handleKey = (key: string): void => {
        const options = matches();
        if (key === '\u0003' || key === '\u0004') return finish('/exit');
        if (key === '\r' || key === '\n') {
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            const command = options[selected].value;
            this.paint('', [], 0, prompt, 0);
            return finish(command);
          }
          return finish(value);
        }
        if (key === '\t' && options.length) {
          value = options[selected].value;
          cursor = value.length;
          return draw();
        }
        if (key === '\u001b[A') {
          if (options.length) selected = (selected - 1 + options.length) % options.length;
          else if (historyIndex > 0) { historyIndex--; value = this.history[historyIndex] ?? ''; cursor = value.length; }
          return draw();
        }
        if (key === '\u001b[B') {
          if (options.length) selected = (selected + 1) % options.length;
          else { historyIndex = Math.min(this.history.length, historyIndex + 1); value = this.history[historyIndex] ?? ''; cursor = value.length; }
          return draw();
        }
        if (key === '\u001b[D') { cursor = previousCharacterIndex(value, cursor); return draw(); }
        if (key === '\u001b[C') { cursor = nextCharacterIndex(value, cursor); return draw(); }
        if (key === '\u007f' || key === '\b') {
          if (cursor > 0) { const previous = previousCharacterIndex(value, cursor); value = value.slice(0, previous) + value.slice(cursor); cursor = previous; }
          return draw();
        }
        if (key === '\u0015') { value = ''; cursor = 0; return draw(); }
        if (key === '\u0001') { cursor = 0; return draw(); }
        if (key === '\u0005') { cursor = value.length; return draw(); }
        if (!key.startsWith('\u001b') && !/[\u0000-\u001f]/.test(key)) {
          value = value.slice(0, cursor) + key + value.slice(cursor);
          cursor += key.length;
          selected = 0;
          draw();
        }
      };
      const onData = (chunk: Buffer | string): void => {
        const keys = String(chunk).match(/\u001b\[[ABCD]|[\s\S]/g) ?? [];
        for (const key of keys) {
          if (finished) break;
          handleKey(key);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      draw();
    });
  }

  /** Provider/model/effort pickers used to be a separate full-screen takeover with
   * their own from-scratch repaint-everything draw loop — the conversation and
   * composer vanished while picking, and every arrow key redrew the whole list from
   * `\u001b[H`. This now renders as a windowed slice of the same palette band `paint()`
   * already draws for slash commands: the picker sits right where the composer is,
   * the conversation stays visible above it, and after the first frame every arrow
   * key is a footer-only repaint instead of a full-screen one. */
  select<T>(title: string, options: readonly PickerOption<T>[]): Promise<T | undefined> {
    if (!options.length) return Promise.resolve(undefined);
    return new Promise((resolveSelection) => {
      this.selecting = true;
      let selected = 0;
      let painted = false;
      const capacity = Math.min(options.length, 8) + 2;
      const renderOptions = options.map((option) => ({ label: option.label, detail: option.detail, value: '' }));
      const draw = (): void => {
        this.paint(title, renderOptions, selected, '', 0, {
          capacity, footerOnly: painted, hideCursor: true,
          hint: '↑↓ move · Enter choose · Esc cancel',
        });
        painted = true;
      };
      let finished = false;
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.selecting = false;
        input.off('data', onData);
        input.setRawMode(false);
        this.paint('', [], 0, '› ', 0);
        resolveSelection(value);
      };
      const handleKey = (key: string): void => {
        if (key === '\u001b[A' || key === 'k') selected = (selected - 1 + options.length) % options.length;
        else if (key === '\u001b[B' || key === 'j') selected = (selected + 1) % options.length;
        else if (key === '\r' || key === '\n') return finish(options[selected].value);
        else if (key === '\u001b' || key === '\u0003' || key === 'q') return finish(undefined);
        else return;
        draw();
      };
      const onData = (chunk: Buffer | string): void => {
        const keys = String(chunk).match(/\u001b\[[ABCD]|[\s\S]/g) ?? [];
        for (const key of keys) {
          if (finished) break;
          handleKey(key);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      draw();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWaiting(false);
    process.off('SIGWINCH', this.onResize);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  suspend(): void {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
  }

  resume(): void {
    if (this.closed) return;
    output.write('\u001b[?1049h');
    if (input.isTTY) input.resume();
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }
}

let activeFullScreenHarness: FullScreenHarnessPrompter | undefined;

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
  const modelLabel = session.model && session.nativeHarness === 'claude'
    ? CLAUDE_ALIAS_LABELS[session.model] ?? session.model
    : session.model;
  return [
    chalk.bold.cyan('ClikCode'),
    ...(session.name ? [line('chat', session.name)] : []),
    line('project', compactPath(session.workspace ?? process.cwd())),
    line('provider', sessionProviderLabel(session)),
    line('account', account ?? 'default'),
    line('model', modelLabel ?? 'provider default'),
    line('effort', session.effort),
    line('access', session.permissionMode ?? 'workspace-write'),
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
      ['/<provider> [request]', 'switch providers, optionally send immediately'],
      ['/provider', 'choose from installed providers'],
      ['/new', 'start a clean conversation'],
      ['/resume', 'choose a saved session'],
      ['/status', 'show the current workspace and settings'],
      ['/account', 'choose, view, or add an account'],
      ['/model <name>', 'choose or view a model'],
      ['/effort <level>', 'set reasoning effort'],
      ['/permissions', 'choose filesystem access'],
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
    output.write(`\n${chalk.bold('Current setup')}\n${renderSessionCard(session, account)}\n\n${chalk.dim('Change with /model, /effort, /account, or /switch.')}\n\n`);
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

async function readState(): Promise<HarnessState> {
  const path = harnessStatePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HarnessState>;
    if (parsed.version !== HARNESS_STATE_VERSION || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
      throw new Error('unsupported local AI harness state');
    }
    // State written by the metadata-only preview gets a secret lazily on its
    // first secure start, preserving account aliases without exposing a window
    // where they are served unauthenticated.
    if (!parsed.localApiToken || !parsed.devicePrivateKeyPem || !parsed.devicePublicKey) {
      const upgraded = {
        ...parsed,
        ...(parsed.localApiToken ? {} : { localApiToken: randomBytes(32).toString('base64url') }),
        ...(!parsed.devicePrivateKeyPem || !parsed.devicePublicKey ? newDeviceSigningIdentity() : {}),
        globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...parsed.globalSettings },
        providerSettings: parsed.providerSettings && typeof parsed.providerSettings === 'object' ? parsed.providerSettings : {},
      } as HarnessState;
      await writeState(upgraded);
      return upgraded;
    }
    // Older previews did not include a failover preference. Migrate those
    // sessions to the safe default so a local account does not remain stuck
    // after its known quota window is exhausted.
    const sessions: HarnessSession[] = (parsed.sessions as HarnessSession[]).map((session) => ({
      ...session,
      accountFailover: (session.accountFailover === 'never' ? 'never' : 'on-quota-exhausted') as HarnessSession['accountFailover'],
      // Sessions created before lifecycle state existed were still open at the
      // time of upgrade, so preserve their resumability once.
      status: session.status === 'closed' || session.status === 'archived' ? session.status : 'active',
      permissionMode: session.permissionMode ?? 'workspace-write',
    }));
    // Older builds invented a 60-second quota reset. A real limit remains
    // exhausted until the user explicitly retries that account or the provider
    // publishes a trustworthy reset signal.
    const accounts = (parsed.accounts as AiHarnessAccount[]).map(({ quotaRetryAt: _obsoleteRetryAt, ...account }) => account);
    const normalized = {
      ...(parsed as HarnessState), accounts, sessions, invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [],
      globalSettings: { ...HARNESS_DEFAULT_SETTINGS, ...parsed.globalSettings },
      providerSettings: parsed.providerSettings && typeof parsed.providerSettings === 'object' ? parsed.providerSettings : {},
    };
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await writeState(normalized);
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Atomic replacement prevents partial writes; the private backup also
      // recovers valid state if the primary was edited or damaged externally.
      try {
        const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8')) as Partial<HarnessState>;
        if (backup.version !== HARNESS_STATE_VERSION || !Array.isArray(backup.accounts) || !Array.isArray(backup.sessions)) throw error;
        const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.recovery`;
        await writeFile(temporary, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, path);
        return readState();
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT' && backupError !== error) throw backupError;
        throw error;
      }
    }
    const fresh: HarnessState = {
      version: HARNESS_STATE_VERSION,
      installationId: randomUUID(),
      localApiToken: randomBytes(32).toString('base64url'),
      ...newDeviceSigningIdentity(),
      accounts: [],
      sessions: [],
      invocations: [],
      globalSettings: { ...HARNESS_DEFAULT_SETTINGS },
      providerSettings: {},
    };
    // The device identity and its loopback bearer must survive the first
    // process exit; otherwise a gateway registration could be valid only for
    // the process that happened to create it.
    await writeState(fresh);
    return fresh;
  }
}

async function writeState(state: HarnessState): Promise<void> {
  const path = harnessStatePath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  // An interrupted write must leave the last complete account/session registry
  // available rather than corrupting every centralized session on next launch.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await copyFile(path, `${path}.bak`).catch(() => undefined);
}

function accountView(account: AiHarnessAccount): Omit<AiHarnessAccount, 'credentialRef'> {
  const { credentialRef: _credentialRef, ...safe } = account;
  return safe;
}

function deviceManifest(state: HarnessState) {
  return {
    protocol: LOCAL_HARNESS_PROTOCOL,
    installationId: state.installationId,
    devicePublicKey: state.devicePublicKey,
    credentialBoundary: 'local-only' as const,
    capabilities: { chat: true, usage: true, sessions: true, gatewayJobs: false },
    accounts: state.accounts.map(accountView),
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id, provider: account.provider, model, status: account.status,
    }))),
  };
}

function requireAuthKind(value: string): AiHarnessAuthKind {
  if (value === 'oauth' || value === 'api-key' || value === 'vendor-cli') return value;
  throw new Error('auth kind must be oauth, api-key, or vendor-cli');
}

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

export async function aiAccountsList(): Promise<void> {
  const state = await readState();
  const accounts = await Promise.all(state.accounts.map(async (account) => ({
    ...accountView(account), usage: await accountUsageLabel(account, state),
  })));
  emitJson({ accounts });
}

/** Lists the normalized local account surfaces without probing provider credentials. */
export async function aiAccountProviders(): Promise<void> {
  emitJson({ harnesses: localRouter().AI_LOCAL_HARNESSES });
}

/** Read-only compatibility report for every catalog entry. */
export async function aiDoctor(): Promise<void> {
  const harnesses = await Promise.all(localRouter().AI_LOCAL_HARNESSES.map(async (harness) => {
    const inspection = await inspectNativeHarness(harness);
    return {
      command: harness.command,
      displayName: harness.displayName,
      provider: harness.provider,
      surface: harness.surface,
      binary: harness.binary,
      install: harness.npmPackage
        ? { kind: 'npm' as const, package: harness.npmPackage, automatic: true }
        : { kind: 'vendor-managed' as const, automatic: false, note: `ClikCode has no publisher to install from; put a \`${harness.binary}\` binary on PATH using ${harness.displayName}'s own installer.` },
      ...inspection,
      capabilities: {
        centralizedTurns: Boolean(harness.turn),
        login: Boolean(harness.loginArgv),
        accountStatus: Boolean(harness.statusArgv),
        logout: Boolean(harness.logoutArgv),
        isolatedProfiles: Boolean(harness.profileEnv),
        modelSelection: Boolean(harness.modelArgvPrefix),
        workspaceSelection: Boolean(harness.workspaceArgvPrefix),
        effortSelection: Boolean(harness.effortArgvPrefix),
        permissionModeSelection: (harness.permissionModes?.length ?? 0) > 0,
        exactResume: Boolean(harness.session?.resumeIdPrefix),
        automaticSessionIdentity: Boolean(harness.session?.createIdPrefix || harness.session?.createSessionArgv || harness.session?.discoverArgv),
        continueLatest: Boolean(harness.session?.continueArgv),
      },
    };
  }));
  emitJson({ adapterVersion: localRouter().AI_LOCAL_HARNESS_ADAPTER_VERSION, harnesses });
}

/** Starts the vendor-owned login flow and records only a local opaque profile reference. */
export async function aiAccountLogin(harnessCommandName: string, label?: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  const state = await readState();
  const accountLabel = (label ?? `${harness.displayName} local`).trim();
  if (!accountLabel) throw new Error('account label cannot be empty');
  const existing = state.accounts.find((account) => account.label.toLowerCase() === accountLabel.toLowerCase());
  if (existing) throw new Error(`a local AI account named "${accountLabel}" already exists`);
  if (!harness.profileEnv && state.accounts.some((account) => account.provider === harness.provider && account.authKind === 'vendor-cli')) {
    throw new Error(`${harness.displayName} does not publish an isolated configuration-root contract; only its default native profile can be registered safely`);
  }
  const accountId = randomUUID();
  const profilePath = harness.profileEnv
    ? join(harnessStatePath(), '..', 'profiles', harness.command, accountId)
    : undefined;
  if (profilePath) await mkdir(profilePath, { recursive: true, mode: 0o700 });
  const nativeProfile = profilePath && harness.profileEnv ? { env: harness.profileEnv, path: profilePath } : undefined;
  await loginNativeHarness(harness, nativeProfile ? { [nativeProfile.env]: nativeProfile.path } : {});
  if (!state.accounts.some((account) => account.label.toLowerCase() === accountLabel.toLowerCase())) {
    state.accounts.push({ id: accountId, provider: harness.provider, label: accountLabel, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${harness.binary}`, ...(nativeProfile ? { nativeProfile } : {}) });
    await writeState(state);
  }
  emitHarnessOutput({ status: 'connected', harness: harness.command, account: accountLabel, credentialBoundary: 'local-only' });
}

function nativeAccountContext(state: HarnessState, labelOrId: string): { account: AiHarnessAccount; harness: AiLocalHarnessDefinition; environment: Record<string, string> } {
  const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
  if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
  if (account.authKind !== 'vendor-cli') throw new Error(`account "${account.label}" is not owned by a vendor CLI`);
  const harness = localHarnessForProvider(account.provider);
  if (!harness) throw new Error(`no native harness is registered for provider ${account.provider}`);
  const environment = account.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
  return { account, harness, environment };
}

export async function aiAccountStatus(labelOrId: string): Promise<void> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harness.statusArgv) throw new Error(`${harness.displayName} does not publish a non-destructive account-status command`);
  const nativeStatus = (await captureNativeHarnessOutput(harness, harness.statusArgv, environment)).trim();
  const usage = await accountUsageLabel(account, state);
  emitJson({ account: { ...accountView(account), usage }, nativeStatus, credentialBoundary: 'local-only' });
}

export async function aiAccountLogout(labelOrId: string): Promise<void> {
  const state = await readState();
  const { account, harness, environment } = nativeAccountContext(state, labelOrId);
  if (!harness.logoutArgv) throw new Error(`${harness.displayName} does not publish a non-interactive logout command`);
  await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
  account.status = 'needs_login';
  await writeState(state);
  emitJson({ account: accountView(account), loggedOut: true, credentialBoundary: 'local-only' });
}

/** No status command published: there is no reliable signal, so assume logged
 * in rather than force a prompt on a user who already authenticated outside
 * ClikCode. A non-zero exit is treated as logged-out unconditionally (true for
 * every status command checked against real output: Codex, Claude Code); an
 * explicit `loggedIn`/`isAuthenticated: false` in a JSON body catches the ones
 * that report failure with exit 0 instead (Cursor Agent). */
async function harnessNeedsLogin(harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>): Promise<boolean> {
  if (!harness.statusArgv) return false;
  let stdout: string;
  try {
    stdout = await captureNativeHarnessOutput(harness, harness.statusArgv, environment, 8_000);
  } catch {
    // fail-open-ok: an unverified account must authenticate before it can be selected safely.
    return true;
  }
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; isAuthenticated?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (parsed.loggedIn === false || parsed.isAuthenticated === false) return true;
    }
  } catch { /* not JSON; exit 0 with no verified false-signal means treat as logged in */ }
  return false;
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
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.model = null;
  }
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.route = 'local';
  session.workspace ??= process.cwd();
  const selected = session.accountId ? state.accounts.find((account) => account.id === session.accountId) : undefined;
  if (!selected || selected.provider !== harness.provider || selected.status !== 'ready') {
    const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.authKind === 'vendor-cli' && account.status === 'ready');
    if (accounts.length === 1) session.accountId = accounts[0].id;
    else if (accounts.length === 0) {
      const account: AiHarnessAccount = {
        id: randomUUID(), provider: harness.provider, label: `${harness.displayName} default`, authKind: 'vendor-cli',
        models: [], status: 'ready', credentialRef: `native:${harness.binary}:default`,
      };
      state.accounts.push(account);
      session.accountId = account.id;
    } else session.accountId = null;
  }
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (activeFullScreenHarness && harness.loginArgv) {
    const environment = account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
    if (freshInstall || await harnessNeedsLogin(harness, environment)) {
      activeFullScreenHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
      activeFullScreenHarness.suspend();
      try {
        await loginNativeHarness(harness, environment);
      } finally {
        activeFullScreenHarness.resume();
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

export async function aiAccountAdd(options: { provider: string; label: string; auth: string; model?: string[]; credentialRef: string }): Promise<void> {
  const provider = options.provider.trim();
  const label = options.label.trim();
  const credentialRef = options.credentialRef.trim();
  if (!provider || !label || !credentialRef) throw new Error('provider, label, and local credential reference are required');
  const auth = requireAuthKind(options.auth);
  if (auth === 'api-key' && !/^env:[A-Z][A-Z0-9_]*$/.test(credentialRef)) {
    throw new Error('API-key accounts require an env:VARIABLE credential reference; raw provider keys are never stored');
  }
  if (auth !== 'api-key' && !/^(?:keychain|native):[^\s]+$/.test(credentialRef)) {
    throw new Error(`${auth} accounts require a keychain: or native: credential reference; raw credentials are never stored`);
  }
  const harness = localHarnessForProvider(provider);
  if (harness && !harness.localAuth.includes(auth)) throw new Error(`${harness.displayName} does not support local ${auth} accounts`);
  const state = await readState();
  if (state.accounts.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`a local AI account named "${label}" already exists`);
  }
  const account: AiHarnessAccount = {
    id: randomUUID(), provider, label, authKind: auth, models: [...new Set(options.model ?? [])],
    status: 'ready', credentialRef,
  };
  state.accounts.push(account);
  await writeState(state);
  emitJson({ account: accountView(account), credentialBoundary: 'local-only' });
}

export async function aiAccountRemove(labelOrId: string): Promise<void> {
  const state = await readState();
  const index = state.accounts.findIndex((account) => account.id === labelOrId || account.label === labelOrId);
  if (index < 0) throw new Error(`local AI account "${labelOrId}" was not found`);
  const [removed] = state.accounts.splice(index, 1);
  state.sessions = state.sessions.map((session) => session.accountId === removed.id ? { ...session, accountId: null } : session);
  await writeState(state);
  emitHarnessOutput({ panel: 'account-removed', account: removed.label });
}

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const VALID_PERMISSION_MODES: readonly AiHarnessPermissionMode[] = ['read-only', 'workspace-write', 'auto'];

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
 * `permissionModes` includes it (today: Codex and Claude Code only). */
function applyDefaultSetting(target: Partial<HarnessDefaultSettings & { model: string }>, key: string, value: string, harness?: AiLocalHarnessDefinition): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'effort') {
    if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.`);
    if (!VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) throw new Error(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
    target.effort = value;
  } else if (normalizedKey === 'permissions' || normalizedKey === 'permissionmode') {
    if (!VALID_PERMISSION_MODES.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be read-only, workspace-write, or auto');
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
  const session: HarnessSession = {
    id: randomUUID(), route: options.route, accountId: account?.id ?? null,
    provider, model: options.model ?? (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
    effort: options.effort ?? defaults.effort, permissionMode: defaults.permissionMode,
    accountFailover: options.accountFailover ?? defaults.accountFailover, createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  emitJson({ session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  emitJson({ sessions: state.sessions });
}

/**
 * The standalone `clikcode` command is a coding-session entrypoint, not a
 * command browser. Resume the most recently used session, creating the first
 * local session on demand so a fresh install lands directly in the TTY.
 */
export async function aiSessionOpenDefault(config: Conf): Promise<void> {
  const state = await readState();
  let session = [...state.sessions]
    .filter((item) => item.status === 'active')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!session) {
    // A closed chat must never reopen without an explicit `sessions open`.
    // Its configuration is still the user's last agent choice, so carry that
    // forward into a clean chat rather than guessing a provider or model.
    const previous = [...state.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const provider = previous?.provider ?? null;
    const defaults = resolveDefaultSettings(state, provider);
    const now = new Date().toISOString();
    session = {
      id: randomUUID(), route: previous?.route ?? 'local', accountId: previous?.accountId ?? null,
      provider, model: (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
      effort: defaults.effort, accountFailover: defaults.accountFailover,
      permissionMode: defaults.permissionMode,
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
  // A session that never received a single turn has nothing to resume — keeping
  // it as "closed" clutter buries real conversations under identical
  // "Untitled chat" entries every time the app is opened and exited without
  // typing anything. Drop it outright instead of accumulating it.
  if (!(session.messages ?? []).length) {
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
    const value = words.shift()?.toLowerCase();
    if (!value) return emitHarnessOutput({ panel: 'permissions', session, controls: ['read-only', 'workspace-write', 'auto'] });
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting permissions.');
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
      const unquoted = action.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
      const workspace = session.workspace ?? process.cwd();
      const path = isAbsolute(unquoted) ? resolve(unquoted) : resolve(workspace, unquoted);
      const info = await stat(path);
      if (!info.isFile()) throw new Error('Attachments must be files.');
      if (info.size > 1024 * 1024) throw new Error('Attachments are limited to 1 MiB each.');
      session.attachments = [...new Set([...(session.attachments ?? []), path])].slice(-10);
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
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
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
      session.route = value;
    } else if (setting === 'account') {
      const account = state.accounts.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase());
      if (!account) throw new Error(`local AI account "${value}" was not found`);
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness?.turn && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      session.provider = account.provider;
      session.route = 'local';
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
      if (session.nativeHarness) {
        const selectedHarness = localHarnessForCommand(session.nativeHarness);
        if (selectedHarness && selectedHarness.provider !== account.provider) throw new Error(`account "${account.label}" belongs to ${account.provider}; select /${localHarnessForProvider(account.provider)?.command ?? account.provider} first`);
      }
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness?.turn && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
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
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', selected: accountView(account), session });
    }
    if (action === 'login') {
      const harnessName = words.shift()?.toLowerCase();
      if (!harnessName) throw new Error('usage: /accounts login <harness> [label]');
      return aiAccountLogin(harnessName, words.join(' ') || undefined);
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
      if (knownHarness?.surface === 'terminal') return aiAccountLogin(knownHarness.command, words.join(' ') || undefined);
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
    session.route = 'gateway';
    session.accountId = null;
    session.provider = 'clikdeploy-gateway';
    session.nativeHarness = undefined;
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'clikdeploy-gateway', account: null, model: 'platform', centralized: true });
  }
  const harness = localHarnessForCommand(head);
  if (harness) {
    await aiHarnessSelect(harness.command, id);
    const firstPrompt = words.join(' ').trim();
    if (firstPrompt) await aiSessionSend(id, firstPrompt);
    return;
  }
  throw new Error(`unknown slash command: /${head}`);
}

interface PickerOption<T> { label: string; detail?: string; value: T }

async function chooseOption<T>(rl: HarnessPrompter, title: string, options: readonly PickerOption<T>[]): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  if (rl.select) return rl.select(title, options);
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
  const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  const defaults = resolveDefaultSettings(state, harness.provider);
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), route: 'local', accountId: accounts.length === 1 ? accounts[0].id : null,
    provider: harness.provider, model: state.providerSettings[harness.provider]?.model ?? null, effort: defaults.effort,
    permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
    workspace: current.workspace ?? process.cwd(), nativeHarness: harness.command, createdAt: now, updatedAt: now, status: 'active',
  };
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
  if (rl instanceof FullScreenHarnessPrompter) rl.suspend();
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
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), route: 'gateway', accountId: null, provider: 'clikdeploy-gateway', model: null,
    effort: current.effort, permissionMode: current.permissionMode, accountFailover: 'never',
    workspace: current.workspace ?? process.cwd(), createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  return session.id;
}

async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const available = await Promise.all(localRouter().AI_LOCAL_HARNESSES
    .filter((harness) => harness.surface === 'terminal' && harness.turn)
    .map(async (harness) => ({ harness, inspection: await inspectNativeHarness(harness, 1_200) })));
  const gatewayConnected = Boolean(ApiClient.getApiKeyForUrl(config, ApiClient.getApiUrl(config)));
  const selected = await chooseOption(rl, 'Choose a provider', [
    { label: 'ClikDeploy Gateway', detail: gatewayConnected ? '· connected' : '· sign in with OAuth', value: '__gateway__' },
    ...available.map(({ harness, inspection }) => ({
      label: harness.displayName,
      detail: inspection.installed
        ? `· installed${inspection.version ? ` ${inspection.version}` : ''}`
        : harness.npmPackage ? '· install on selection' : '· vendor install required',
      value: harness.command,
    })),
  ]);
  if (!selected) return undefined;
  if (selected === '__gateway__') return newGatewayConversation(config, rl, id);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (!current.nativeHarness) {
    await aiHarnessSelect(selected, id);
    return id;
  }
  return newProviderConversation(id, selected);
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

async function interactiveAccountPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const accounts = state.accounts.filter((account) => account.status === 'ready');
  const usages = await Promise.all(accounts.map((account) => accountUsageLabel(account, state)));
  const selected = await chooseOption(rl, 'Choose an account', [
    ...accounts.map((account, index) => ({
      label: account.label,
      detail: `· ${account.provider}${usages[index] ? ` · ${usages[index]}` : ''}${account.quotaState === 'exhausted' ? ` · ${chalk.yellow('quota exhausted')}` : ''}${account.id === session.accountId ? ' · current' : ''}`,
      value: account.label,
    })),
    { label: 'Add another account…', detail: 'vendor login', value: '__add__' },
  ]);
  if (!selected) return;
  if (selected !== '__add__') {
    await aiSessionCommand(id, `/settings account ${selected}`);
    return;
  }
  const installed = (await Promise.all(localRouter().AI_LOCAL_HARNESSES
    .filter((harness) => harness.surface === 'terminal' && harness.turn)
    .map(async (harness) => ({ harness, inspection: await inspectNativeHarness(harness, 1_200) }))))
    .filter((item) => item.inspection.installed);
  const harnessCommand = await chooseOption(rl, 'Add an account for', installed.map(({ harness }) => ({
    label: harness.displayName, value: harness.command,
  })));
  if (!harnessCommand) return;
  const harness = localHarnessForCommand(harnessCommand)!;
  const suggested = `${harness.displayName} ${accounts.filter((account) => account.provider === harness.provider).length + 1}`;
  const entered = (await rl.question(`Account name ${chalk.dim(`[${suggested}]`)} › `)).trim();
  const label = entered || suggested;
  await aiAccountLogin(harness.command, label);
  await aiSessionCommand(id, `/settings account ${label}`);
}

async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<string | undefined> {
  const state = await readState();
  // A session with no turns yet has nothing to resume into — showing it here is
  // indistinguishable from a real conversation until you're already inside it,
  // and older empty sessions (from before aiSessionClose started dropping them)
  // otherwise bury every real, titled conversation under identical
  // "Untitled chat" entries. Always keep the current session visible even if
  // it's still empty, so picking "current" back out of the list still works.
  const sessions = state.sessions
    .filter((session) => session.id === currentId || (session.messages ?? []).length > 0)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return chooseOption(rl, 'Resume a session', sessions.map((session) => {
    const model = session.model && session.nativeHarness === 'claude'
      ? CLAUDE_ALIAS_LABELS[session.model] ?? session.model
      : session.model;
    return {
      label: `${sessionProviderLabel(session)} • ${session.name ?? 'Untitled chat'}`,
      detail: `· ${session.id === currentId ? 'current · ' : ''}${model ?? 'automatic'} · ${session.status} · ${new Date(session.updatedAt).toLocaleString()}`,
      value: session.id,
    };
  }));
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
  if (value) await applySettingScope(rl, id, 'model', value);
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
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const current = session.permissionMode ?? 'workspace-write';
  const descriptions: Record<AiHarnessPermissionMode, string> = {
    'read-only': 'inspect and plan; deny writes',
    'workspace-write': 'allow edits inside this project',
    auto: 'provider reviews approval requests automatically',
  };
  const supported = harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : VALID_PERMISSION_MODES;
  if (!supported.length) throw new Error(`${harness?.displayName ?? 'This provider'} does not map ClikCode's permission modes to a real flag.`);
  const selected = await chooseOption(rl, 'Choose filesystem access', supported.map((value) => ({
    label: value, detail: `· ${descriptions[value]}${value === current ? ' · current' : ''}`, value,
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
    { label: 'Provider', detail: 'choose a coding harness', value: 'provider' },
    { label: 'Account', detail: 'switch login/profile', value: 'account' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: 'provider default or model ID', value: 'model' }] : []),
    ...(harness && harnessSupportsEffort(harness) ? [{ label: 'Reasoning effort', detail: 'provider-supported levels', value: 'effort' }] : []),
    ...(harness?.permissionModes?.length ? [{ label: 'Filesystem access', detail: 'provider-supported access policy', value: 'permissions' }] : []),
    ...(harness && localHarnessCapabilityManifest(harness).options.some((option) => !['model', 'effort', 'workspace', 'permissions'].includes(option.id))
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    { label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover' },
    { label: 'Show current setup', value: 'status' },
  ] as const);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'account') await interactiveAccountPicker(rl, id);
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
  const state = await readState();
  let session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const commandDetails: Record<string, string> = {
    '/provider': 'choose a provider', '/gateway': 'switch to ClikDeploy Gateway', '/settings': 'configure this workspace', '/account': 'choose, view, or add an account',
    '/model': 'choose or view a model', '/effort': 'reasoning level', '/permissions': 'filesystem access',
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
  let notice: string | undefined;
  try {
    while (true) {
      let line: string;
      try {
        const latestState = await readState();
        const latest = latestState.sessions.find((item) => item.id === id);
        if (!latest) break;
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
        await aiSessionClose(id);
        break;
      }
      try {
        const command = line.toLowerCase();
        if (command === '/switch' || command === '/engine' || command === '/provider') {
          const selected = await interactiveEnginePicker(config, rl, id);
          if (selected && selected !== id) { id = selected; continue; }
        }
        else if (command === '/gateway') {
          id = await newGatewayConversation(config, rl, id);
          continue;
        }
        else if (command === '/account' || command === '/accounts') await interactiveAccountPicker(rl, id);
        else if (command === '/model') await interactiveModelPicker(rl, id);
        else if (command === '/effort') await interactiveEffortPicker(rl, id);
        else if (command === '/permissions') await interactivePermissionPicker(rl, id);
        else if (command === '/options') await interactiveHarnessOptionPicker(rl, id);
        else if (command === '/capabilities') {
          const commandState = await readState();
          const commandSession = commandState.sessions.find((item) => item.id === id);
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
            if (selected && selected !== id) { id = selected; continue; }
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
          if (selected && selected !== id) {
            // Resuming picks up a conversation's content, not necessarily its
            // original vendor: staying on whatever you're already running is
            // the point of switching providers in the first place — reopening
            // an old chat shouldn't silently pull you back to a different one.
            const resumeState = await readState();
            const current = resumeState.sessions.find((item) => item.id === id);
            const target = resumeState.sessions.find((item) => item.id === selected);
            if (current?.nativeHarness && target && target.nativeHarness !== current.nativeHarness) {
              const originalLabel = sessionProviderLabel(target);
              target.nativeHarness = current.nativeHarness;
              target.provider = current.provider;
              target.accountId = current.accountId;
              target.model = null;
              target.nativeSessionId = undefined;
              target.nativeStartedAt = undefined;
              target.updatedAt = new Date().toISOString();
              await writeState(resumeState);
              notice = `Continuing this ${originalLabel} chat under ${sessionProviderLabel(current)}.`;
            }
            id = selected;
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
          const environment = selectedAccount?.nativeProfile ? { [selectedAccount.nativeProfile.env]: selectedAccount.nativeProfile.path } : {};
          if (manager.listArgv) {
            const result = await captureNativeHarnessOutput(selectedHarness, manager.listArgv, environment);
            rl.panel?.(manager.label, result || 'No entries.');
            if (rl.render) await rl.question('Press Enter to return › ');
          } else if (manager.manageArgv && rl instanceof FullScreenHarnessPrompter) {
            rl.suspend();
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
            activeFullScreenHarness?.startWaiting('thinking', () => turnController.abort());
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
        if (rl.render) notice = cancelled ? 'Stopped' : `Error: ${message}`;
        else emitHarnessOutput({ panel: 'error', message });
      }
    }
  } finally {
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
    for (;;) {
      const environment = account.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
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
        permissionMode: session.permissionMode ?? 'workspace-write', images, options: session.harnessOptions,
      });
      // Persist an allocated native identity before the provider starts so an
      // interrupted turn cannot accidentally fork the centralized conversation.
      if (createdHere) await writeState(state);
      const turnOutput = await captureNativeHarnessTurn(
        harness, argv, environment, {
          cwd: session.workspace,
          signal,
          stdinText: harness.turn.promptInput === 'stdin' ? turnText : undefined,
          onStdoutLine: (lineText) => {
            const phase = nativeActivityPhase(lineText);
            if (phase) activeFullScreenHarness?.phase(phase);
            const activity = nativeActivityLine(harness, lineText);
            if (activity && activeFullScreenHarness) activeFullScreenHarness.activity(activity.trim());
            else if (activity) output.write(`${activity}\n`);
          },
        },
      );
      if (turnOutput.interrupted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
      const result = nativeTurnResult(harness, turnOutput.stdout);
      if (!session.nativeSessionId && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
      if (turnOutput.exitCode !== 0 || result.isError) {
        const failure = Object.assign(new Error(`${harness.displayName}: ${result.text}`), { statusCode: result.statusCode });
        const failureKind = classifyAccountFailure(failure);
        if (failureKind === 'authentication-required') {
          account.status = 'needs_login';
          await writeState(state);
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
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; name?: string; tool?: string };
        if (event.type === 'delta' && typeof event.text === 'string') {
          activeFullScreenHarness?.phase('generating response');
          reply += event.text;
          if (streamToTerminal) { output.write(event.text); wroteDelta = true; }
        }
        if (activeFullScreenHarness && /reasoning|thinking/.test(event.type ?? '') && event.text?.trim()) {
          activeFullScreenHarness.activity(`${chalk.cyan('thinking')} ${chalk.dim(visibleSlice(event.text.trim().replace(/\s+/g, ' '), 140))}`);
        }
        if (activeFullScreenHarness && /tool/.test(event.type ?? '')) {
          activeFullScreenHarness.activity(`${chalk.yellow('tool')} ${chalk.dim(event.name ?? event.tool ?? 'tool')}`);
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

export async function aiSessionSet(id: string, options: { route?: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted'; nativeSession?: string }): Promise<void> {
  if (options.route !== undefined && options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  const state = await readState();
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`AI session "${id}" was not found`);
  const current = state.sessions[index];
  const account = options.account === undefined
    ? undefined
    : state.accounts.find((item) => item.id === options.account || item.label === options.account);
  if (options.account !== undefined && !account) throw new Error(`local AI account "${options.account}" was not found`);
  if (options.nativeSession !== undefined) {
    if (!current.nativeHarness) throw new Error('launch a native harness for this ClikCode session before attaching its native session id');
    const harness = localHarnessForCommand(current.nativeHarness);
    if (!harness?.session?.resumeIdPrefix) throw new Error(`${harness?.displayName ?? current.nativeHarness} does not declare exact native-session resume support`);
    if (!options.nativeSession.trim()) throw new Error('native session id cannot be empty');
  }
  const next: HarnessSession = {
    ...current,
    ...(options.route ? { route: options.route } : {}),
    ...(account ? { accountId: account.id, provider: options.provider ?? account.provider } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.accountFailover ? { accountFailover: options.accountFailover } : {}),
    ...(options.nativeSession !== undefined ? { nativeSessionId: options.nativeSession.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  state.sessions[index] = next;
  await writeState(state);
  emitJson({ session: next });
}
