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
  ADOPTED_TRANSCRIPT_READERS, conversationTitle, discoverNativeSessions, FS_SESSION_DISCOVERY, type DiscoveredNativeSession,
} from './native-session-discovery.js';

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
export interface AiLocalHarnessDefinition {
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
    discoverFormat?: 'json' | 'json-lines' | 'text' | 'numbered-list';
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
  // Distinct from `messages`: a string `error` field is a failure reason,
  // never the assistant's own reply, so it must never end up as the
  // returned "text" for a successful-looking turn -- but without capturing
  // it separately, a genuine failure with no text in any of `fields` (a
  // real, verified shape: Antigravity CLI's own {status:"ERROR",
  // error:"API error...", response:""}) surfaced only as a generic
  // "returned no assistant text", discarding the real reason entirely.
  let errorMessage: string | undefined;
  const visit = (value: unknown, parentType?: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentType));
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : parentType;
    // record.status as a string 'ERROR'/'FAILED' is a real, distinct shape
    // from the number >= 400 check below it -- caught verifying Antigravity
    // CLI live: its own result event is {status: "ERROR", error: "<message
    // string>", response: ""}, which the boolean-only check above never
    // matched. A generic check, not Antigravity-specific: any other harness
    // using this same string-status convention benefits the same way, and
    // it can't collide with the number check since they're different types.
    if (record.is_error === true || record.error === true || (typeof record.status === 'string' && /^(error|failed)$/i.test(record.status))) isError = true;
    if (typeof record.api_error_status === 'number') statusCode = record.api_error_status;
    else if (typeof record.status === 'number' && record.status >= 400) statusCode = record.status;
    if (typeof record.error === 'string' && record.error.trim()) errorMessage = record.error.trim();
    for (const [key, child] of Object.entries(record)) {
      if (fields.has(key) && typeof child === 'string' && child.trim()) {
        // JSON event streams often contain tool input and user echoes. Only
        // accept generic text/content from assistant/result-shaped events.
        if (!['text', 'content'].includes(key) || !type || /assistant|agent|message|result|complete|text/i.test(type)) messages.push(child.trim());
      } else visit(child, type);
    }
  };
  values.forEach((value) => visit(value));
  // errorMessage only as a fallback, never preferred over real assistant
  // text -- a turn that produced actual output before failing partway
  // through should still show that output, not the failure reason instead
  // of it.
  const text = messages[messages.length - 1]?.trim() || errorMessage;
  if (!text) throw new Error(`${harness.displayName} returned no assistant text in its structured output`);
  const ids = nativeSessionIds(stdout, harness.turn.output);
  return { text, nativeSessionId: [...ids][0], ...(isError ? { isError } : {}), ...(statusCode ? { statusCode } : {}) };
}

/** Render provider JSONL as a small provider-neutral activity stream. */
/**
 * Every harness's own JSON envelope is a different shape (Codex's generic
 * `item.type` + `started`/`completed` states, Claude's `stream-json` content
 * array, opencode's top-level `type` with a `part` object) -- but what a user
 * actually needs to see collapses into the same handful of things happening:
 * the model is thinking, a tool started, a tool finished, or it's generating
 * the reply text. This is that common shape: each vendor's parser below maps
 * its own real, verified envelope into one of these, and exactly one
 * renderer (below) turns any of them into the same glyph/color/wording
 * regardless of which harness produced it -- a Codex tool call and a Claude
 * Code tool call read identically once they reach here.
 */
interface HarnessActivityEvent {
  kind: 'thinking' | 'tool-start' | 'tool-done';
  label: string;
  /** Only ever populated where the harness's own JSON genuinely carries the
   * before/after text (confirmed so far: Claude Code's Edit/Write tool_use
   * blocks) -- never synthesized from a "files updated" style event that
   * doesn't actually include the changed content. Each side is already
   * capped to a few lines before this is built; the activity trail below is
   * a 5-line rolling window (see FullScreenHarnessPrompter.activity), not a
   * scrollback viewer, so an uncapped diff would just silently lose its
   * earlier lines to the window sliding past them, not show a real "more"
   * indicator -- capping here means the +N truncation notice is honest. */
  diff?: { removed: string[]; added: string[] };
}

/** Line-capped, not byte-capped: a diff that's still readable at a glance
 * beats a byte-perfect one that pushes everything else out of the 5-line
 * activity window. */
function capDiffLines(text: string, max: number): { lines: string[]; truncated: number } {
  const all = text.split(/\r?\n/);
  return { lines: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

function parseNativeActivityEvent(harness: AiLocalHarnessDefinition, lineText: string): HarnessActivityEvent | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    // fail-open-ok: plain-text harness output has no structured activity metadata to parse.
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
    return summary ? { kind: 'thinking', label: visibleSlice(summary.replace(/\s+/g, ' '), 140) } : undefined;
  }
  if (/command_execution/.test(itemType) && /started|completed/.test(type)) {
    const command = String(item?.command ?? item?.command_line ?? '').trim();
    return command ? { kind: type.endsWith('completed') ? 'tool-done' : 'tool-start', label: command } : undefined;
  }
  if (/file_change/.test(itemType) && /completed/.test(type)) return { kind: 'tool-done', label: 'files updated' };
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.name ?? item?.server ?? 'tool');
    return { kind: type.endsWith('completed') ? 'tool-done' : 'tool-start', label: name };
  }
  if (harness.command === 'claude') {
    if (type === 'system' && value.subtype === 'init') return undefined;
    if (type === 'assistant') {
      const message = value.message as { content?: Array<Record<string, unknown>> } | undefined;
      const tool = message?.content?.find((part) => part.type === 'tool_use');
      if (!tool) return undefined;
      const name = String(tool.name ?? 'tool');
      const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : undefined;
      // Verified against this exact session's own transcript: Edit's
      // input carries old_string/new_string verbatim, Write carries the
      // full new file as `content` with no prior text to diff against.
      // Capped to 4 lines a side -- the 5-line activity window can't show
      // more anyway, and a truncation count beats a silently-scrolled-off
      // tail.
      if (name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
        const removed = capDiffLines(input.old_string, 4);
        const added = capDiffLines(input.new_string, 4);
        return {
          kind: 'tool-start', label: name,
          diff: {
            removed: [...removed.lines, ...(removed.truncated ? [`… ${removed.truncated} more line${removed.truncated === 1 ? '' : 's'}`] : [])],
            added: [...added.lines, ...(added.truncated ? [`… ${added.truncated} more line${added.truncated === 1 ? '' : 's'}`] : [])],
          },
        };
      }
      if (name === 'Write' && typeof input?.content === 'string') {
        const added = capDiffLines(input.content, 4);
        return { kind: 'tool-start', label: name, diff: { removed: [], added: [...added.lines, ...(added.truncated ? [`… ${added.truncated} more line${added.truncated === 1 ? '' : 's'}`] : [])] } };
      }
      return { kind: 'tool-start', label: name };
    }
  }
  // opencode's own envelope is a different shape entirely: a top-level `type`
  // (not nested under `item`) and a `part` object instead of an `item` one.
  // Verified against a real `opencode run --format json` turn, including one
  // that actually called a tool — `part.tool` is the tool name and
  // `part.state.status` tracks completion.
  if (harness.command === 'opencode' && type === 'tool_use') {
    const part = value.part && typeof value.part === 'object' ? value.part as Record<string, unknown> : undefined;
    const state = part?.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : undefined;
    const name = String(part?.tool ?? 'tool');
    return { kind: state?.status === 'completed' ? 'tool-done' : 'tool-start', label: name };
  }
  // Command Code's envelope wraps each lifecycle event under a top-level
  // `{ type: 'event', event: {...} }` (distinct from its `{ type: 'result' }`
  // terminal frame) -- verified against its own docs, though only the
  // `tool_running` value itself was confirmed there, not a paired
  // completion event, so this only ever reports 'tool-start'.
  if (harness.command === 'command' && type === 'event') {
    const inner = value.event && typeof value.event === 'object' ? value.event as Record<string, unknown> : undefined;
    if (inner?.type === 'tool_running') return { kind: 'tool-start', label: String(inner.toolName ?? 'tool') };
  }
  // Pi's own envelope: a flat `{ type: 'toolcall_start', toolName }` --
  // verified from its own docs (packages/coding-agent/docs/json.md), but
  // the docs excerpt available didn't name a paired completion event, so
  // (same as Command Code above) this only ever reports 'tool-start'.
  if (harness.command === 'pi' && type === 'toolcall_start') {
    return { kind: 'tool-start', label: String(value.toolName ?? 'tool') };
  }
  return undefined;
}

/** The one place that decides what a completed/in-progress tool call or a
 * thinking summary looks like in the persistent activity log -- every
 * harness's parser above feeds this same renderer, so the visual language
 * (glyph, color, wording) never drifts per-vendor. */
/** A code-change tool call (Edit/Write, or any other harness's own naming
 * for the same thing) gets its own color -- magenta -- distinct from a
 * generic tool call's yellow/green, the same way Claude Code's own UI
 * visually separates "a tool ran" from "a file changed" rather than
 * treating every tool call identically. Name-pattern matching (not just
 * `event.diff`'s presence) so this applies even for harnesses where the
 * diff content itself isn't available yet -- Codex's file_change events,
 * for instance, still get the distinct color even without line content. */
function isCodeChangeLabel(label: string): boolean {
  return /^(edit|write|patch)$/i.test(label) || /file/i.test(label);
}

function renderActivityLine(event: HarnessActivityEvent): string[] {
  if (event.kind === 'thinking') return [`  ${chalk.cyan('thinking')} ${chalk.dim(event.label)}`];
  const isCodeChange = Boolean(event.diff) || isCodeChangeLabel(event.label);
  const glyph = isCodeChange ? chalk.magenta('edit') : (event.kind === 'tool-done' ? chalk.green('done') : chalk.yellow('tool'));
  const summary = `  ${glyph} ${chalk.dim(event.label)}`;
  if (!event.diff) return [summary];
  const diffLines = [
    ...event.diff.removed.map((line) => `    ${chalk.red(`- ${line}`)}`),
    ...event.diff.added.map((line) => `    ${chalk.green(`+ ${line}`)}`),
  ];
  return [summary, ...diffLines];
}

/** Same idea for the spinner's own label: while a tool is actively running,
 * show what it's doing instead of a static "thinking" the whole time. */
function renderActivityPhase(event: HarnessActivityEvent): string {
  if (event.kind === 'tool-start') return `running ${event.label}`;
  if (event.kind === 'thinking') return 'thinking';
  return 'generating response';
}

function nativeActivityPhase(harness: AiLocalHarnessDefinition, lineText: string): 'generating response' | undefined {
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
  if (harness.command === 'opencode' && type === 'text') return 'generating response';
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

type ModelCatalogResult = { configured?: string; models: string[]; labels?: Readonly<Record<string, string>> };
// Model lists change even less often than installation status -- 5 minutes
// is conservative, not aggressive. Without this, every single /model open
// re-ran a real subprocess (harness.modelDiscoveryArgv) with up to a
// 12-second timeout for any harness that declares one (opencode, several
// others) -- on top of inspectNativeHarness's own cost this stacked into
// exactly the "options are still slow" report, in a second picker beyond
// /provider.
const modelCatalogCache = new Map<string, { at: number; result: ModelCatalogResult }>();
const MODEL_CATALOG_CACHE_TTL_MS = 300_000;

async function nativeModelCatalog(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
  const cacheKey = `${harness.command}:${account?.nativeProfile?.path ?? account?.id ?? 'default'}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_CACHE_TTL_MS) return cached.result;
  const result = await nativeModelCatalogUncached(harness, account);
  modelCatalogCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

async function nativeModelCatalogUncached(
  harness: AiLocalHarnessDefinition,
  account?: AiHarnessAccount,
): Promise<ModelCatalogResult> {
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
    // No injected model-name list here on purpose: unlike Claude's alias
    // names just above (confirmed directly from `claude --help`'s own
    // documented flag values, plus verified live against real turns),
    // there is no equivalent verified source for Gemini's -- the previous
    // ['auto','pro','flash','flash-lite'] list was never confirmed against
    // Gemini CLI itself, and checking Antigravity CLI's real, live `models`
    // output (a different tool that also routes to Gemini models) showed
    // genuinely different, more specific names entirely
    // (gemini-3.8-flash-high, etc.) -- meaning that list was already
    // presenting stale/wrong data as if it were reliable. No Gemini CLI
    // command or local file was found that actually lists its own models
    // (confirmed: no `models` subcommand in --help, no cache file under
    // ~/.gemini/). Better to show only what's genuinely known (`configured`
    // from settings.json, or an account's own explicitly set models) than a
    // guess that looks like real data.
  }
  // Copilot had the same problem, worse: a full hardcoded model list with
  // no discovery mechanism and no verification against Copilot CLI itself
  // ever performed -- checked its own GitHub issue tracker directly
  // (github/copilot-cli#700, #1356, #236), which confirms this is a known,
  // still-open gap in Copilot CLI itself: there is no `copilot models`
  // command, only an interactive picker with no scriptable equivalent.
  // Removed rather than kept as a guess.
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
    const period = minutes === 300 ? '5h' : minutes === 10_080 ? 'weekly' : minutes < 1_440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1_440)}d`;
    return [`${period} ${Math.max(0, Math.min(100, 100 - used))}%`];
  });
  return parts.length ? parts.join(' · ') : undefined;
}

/** Claude Code has no public CLI flag or subcommand for this (confirmed:
 * `--help` and `doctor` both show nothing), but the same data Claude Code's
 * own interactive UI displays is one authenticated call away: its own OAuth
 * token — already sitting in ~/.claude/.credentials.json, refreshed by
 * Claude Code's own background daemon — is accepted by
 * `/api/oauth/usage`, the private endpoint its UI calls internally.
 * Verified live: real five_hour/seven_day utilization percentages, matching
 * what the interactive session shows. This reads an already-authenticated
 * user's own token to display their own account's own usage, the same data
 * the vendor's own client already shows them — not a new grant of access. */
async function claudeUsageProbe(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  // Real bug, not a hypothetical: this ignored both its parameters entirely
  // and always read the default ~/.claude path, so every Claude Code
  // account -- including genuinely isolated ones under their own
  // CLAUDE_CONFIG_DIR (see the profileEnv on its catalog entry) -- reported
  // the same, first account's usage. The caller (nativeUsageLabel) already
  // computes the right environment per account; this just wasn't using it.
  let token: string | undefined;
  try {
    const configDir = environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const raw = await readFile(join(configDir, '.credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    token = typeof parsed.claudeAiOauth?.accessToken === 'string' ? parsed.claudeAiOauth.accessToken : undefined;
  } catch { return undefined; }
  if (!token) return undefined;
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = await response.json() as {
      five_hour?: { utilization?: number };
      seven_day?: { utilization?: number };
    };
    const parts: string[] = [];
    if (typeof body.five_hour?.utilization === 'number') parts.push(`5h ${Math.max(0, Math.min(100, 100 - body.five_hour.utilization))}%`);
    if (typeof body.seven_day?.utilization === 'number') parts.push(`weekly ${Math.max(0, Math.min(100, 100 - body.seven_day.utilization))}%`);
    return parts.length ? parts.join(' · ') : undefined;
  } catch { return undefined; }
}

const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageProbe>>> = {
  codex: codexUsageProbe,
  opencode: opencodeUsageProbe,
  claude: claudeUsageProbe,
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

function sessionEngine(session: HarnessSession): string {
  return session.route === 'gateway' ? 'gateway' : session.nativeHarness ?? session.provider ?? 'none';
}

function sessionProviderLabel(session: HarnessSession): string {
  if (session.route === 'gateway') return 'ClikDeploy Gateway';
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  return harness?.displayName ?? session.provider ?? 'Not selected';
}

interface HarnessPrompter {
  question(prompt: string, commands?: readonly PickerOption<string>[], settings?: { cancellable?: boolean }): Promise<string>;
  select?<T>(title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>): Promise<T | undefined>;
  render?(session: HarnessSession, account?: string, notice?: string): void;
  panel?(title: string, body: string): void;
  close(): void;
}

/** Vendor responses come back as real markdown, but the transcript view is a
 * fixed-width character grid with no rich-text renderer behind it — showing
 * that syntax verbatim (literal ** around bold text, backticks around code,
 * a raw [text](url) pair) reads as visibly broken rather than styled. Strips
 * the syntax down to plain, readable text instead of attempting real
 * rendering: bold/italic markers are dropped (chalk styling would have to
 * survive the character-offset word-wrap below, which slices through ANSI
 * codes with no awareness of them), inline code keeps its content without
 * the backticks, and links keep their label with the URL alongside it. */
/** Applies `style` to each word of `text` individually, leaving whitespace
 * untouched -- not one open/close pair around the whole phrase. wrapWords
 * measures visible width correctly through embedded ANSI codes already, but
 * it still breaks lines on whitespace, so a single open-code-at-the-start,
 * close-code-at-the-end span would leave its close code stranded on a
 * different wrapped line than its open code if the phrase wraps, `-- not
 * corrupting anything (chalk's own codes are self-contained), but silently
 * losing the styling on whichever words landed after the break. Per-word
 * styling means every word carries its own complete open+close pair, so a
 * mid-phrase wrap just ends one styled run and starts another identical
 * one -- no dependency on where the line happens to break. */
function styleWords(text: string, style: (word: string) => string): string {
  return text.split(/(\s+)/).map((part) => (part && !/^\s+$/.test(part) ? style(part) : part)).join('');
}

/** Inline spans (bold/italic/code/links) get real ANSI styling instead of
 * being discarded -- unlike the header/bullet/list handling in
 * formatParagraph, which strips its own markers because the paragraph-level
 * prefix system already conveys that structure. Code spans are converted
 * first, specifically so literal asterisks inside inline code (a glob
 * pattern, a multiplication in a comment) can't get misread as a bold/italic
 * marker by the regexes that run after -- the reverse order would let
 * that happen, and the original plain-text stripMarkdown() this replaced
 * had exactly that latent ordering issue. */
// One combined regex, one single `.replace()` pass -- NOT the sequential
// per-construct `.replace()` chain this used to be. That chain had a real
// bug: each pass ran against the *output* of the previous one, which by
// then already contained chalk escape codes like `\x1b[1m` -- and an escape
// code's own `[` is indistinguishable, to a naive `\[...\]` link regex,
// from a real markdown link's opening bracket. A bold span earlier in the
// paragraph could supply that stray `[`, and the link regex would then
// greedily consume everything from there up to the *next* real `]` --
// which might be a real link many words later -- wrapping that whole
// stretch in underline. Matching everything in one pass against the
// original, escape-code-free text closes that off entirely: every
// construct is found at its real source position exactly once, and nothing
// ever gets re-scanned after styling is applied.
const INLINE_MARKDOWN_PATTERN = /`([^`]+)`|(\*\*\*|___)(.+?)\2|(\*\*|__)(.+?)\4|(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)|\[([^\]]+)\]\(([^)]+)\)/g;

function renderInlineMarkdown(text: string): string {
  return text.replace(
    INLINE_MARKDOWN_PATTERN,
    (_match, code: string | undefined, _boldItalicMarker, boldItalic: string | undefined, _boldMarker, bold: string | undefined, italic: string | undefined, linkLabel: string | undefined, linkUrl: string | undefined) => {
      if (code !== undefined) return styleWords(code, (word) => chalk.cyan(word));
      if (boldItalic !== undefined) return styleWords(boldItalic, (word) => chalk.bold(chalk.italic(word)));
      if (bold !== undefined) return styleWords(bold, (word) => chalk.bold(word));
      if (italic !== undefined) return styleWords(italic, (word) => chalk.italic(word));
      if (linkLabel !== undefined) return `${styleWords(linkLabel, (word) => chalk.underline(word))} ${chalk.dim(`(${linkUrl})`)}`;
      return _match;
    },
  );
}

type MessageBlock = { kind: 'code'; lines: string[] } | { kind: 'text'; paragraph: string };

/** Fenced code blocks are pulled out as their own non-reflowed unit before
 * the normal per-paragraph pipeline ever sees them -- word-wrapping code
 * would change what it means (a wrapped shell command or JSON blob reads
 * differently than the original), so those lines get hard-truncated instead
 * of wrapped when rendered, same principle as visibleSlice elsewhere in
 * this file. */
function splitIntoBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const parts = text.split(/```[a-z]*\n?/i);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ kind: 'code', lines: part.replace(/```$/, '').split(/\r?\n/).filter((_line, lineIndex, all) => !(lineIndex === all.length - 1 && all[lineIndex] === '')) });
    } else {
      for (const paragraph of part.split(/\r?\n/)) blocks.push({ kind: 'text', paragraph });
    }
  });
  return blocks;
}

/** Every harness's assistant text is plain markdown-convention prose
 * regardless of vendor, so this -- unlike HarnessActivityEvent's per-vendor
 * JSON parsing -- applies identically no matter which harness produced the
 * paragraph: a header renders bold, a list item gets a dim glyph and a
 * hanging indent for any wrapped continuation lines, and anything else
 * passes through untouched. Deliberately paragraph-level, not span-level --
 * inline styling (bold *within* a sentence) would need wrapWords to track
 * open ANSI codes across a wrap boundary, which stripMarkdown already
 * discards to plain text; a header or list marker is always at the start of
 * its own paragraph, so no such boundary problem exists here. */
interface FormattedParagraph {
  prefix: string;
  hangIndent: string;
  text: string;
  bold: boolean;
  /** A horizontal rule has no text at all -- the render loop draws a full
   * dim rule line and skips wrapping entirely for it. */
  rule: boolean;
}

function formatParagraph(paragraph: string): FormattedParagraph {
  if (/^([-*_])\1{2,}\s*$/.test(paragraph.trim())) return { prefix: '', hangIndent: '', text: '', bold: false, rule: true };
  const header = /^#{1,6}\s+(.*)$/.exec(paragraph);
  if (header) return { prefix: '', hangIndent: '', text: header[1], bold: true, rule: false };
  const quote = /^>\s?(.*)$/.exec(paragraph);
  // Only the marker is dim, not chalk.dim() around the whole line -- bold
  // and dim share the same SGR "normal intensity" reset code (22), so
  // concatenating a dim-wrapped string around a separately-bold-wrapped
  // inline span (from renderInlineMarkdown, applied after this returns)
  // would let the bold span's own reset code end the dim early for the
  // rest of the line. Chalk only fixes that automatically for styles
  // nested as actual JS calls (chalk.dim(chalk.bold(x))), not for
  // pre-rendered strings spliced together afterward, which is what happens
  // here -- so this sidesteps the collision instead of triggering it.
  if (quote) return { prefix: `${chalk.dim('│')} `, hangIndent: '  ', text: quote[1], bold: false, rule: false };
  const bullet = /^([-*+])\s+(.*)$/.exec(paragraph);
  if (bullet) return { prefix: `${chalk.dim('•')} `, hangIndent: ' '.repeat(2), text: bullet[2], bold: false, rule: false };
  const numbered = /^(\d+[.)])\s+(.*)$/.exec(paragraph);
  // hangIndent is a plain space string matching the *visible* width of
  // `prefix` (marker plus its trailing space) exactly -- not a rounded
  // approximation -- so a wrapped continuation line lines up under the
  // first line's text instead of drifting a column off, which an earlier
  // "round up to a 2-space unit" version of this got wrong for any
  // odd-length marker (e.g. a 2-character "2." plus its space is 3 wide,
  // not the 4 that formula produced).
  if (numbered) return { prefix: `${chalk.dim(numbered[1])} `, hangIndent: ' '.repeat(numbered[1].length + 1), text: numbered[2], bold: false, rule: false };
  return { prefix: '', hangIndent: '', text: paragraph, bold: false, rule: false };
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

/** Greedy word-wrap that never splits a word across lines, measuring by
 * terminal cell width (so wide/CJK characters count correctly) rather than
 * raw string length. A single word longer than `width` on its own still has
 * to be hard-broken -- there's no other way to fit it -- but that's the
 * fallback, not the common case the plain character-slice loop this
 * replaced used unconditionally. */
function wrapWords(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if (/^\s+$/.test(word)) {
      if (currentWidth > 0) { current += word; currentWidth += terminalCellWidth(word); }
      continue;
    }
    const wordWidth = terminalCellWidth(word);
    if (currentWidth > 0 && currentWidth + wordWidth > safeWidth) {
      lines.push(current.replace(/\s+$/, ''));
      current = '';
      currentWidth = 0;
    }
    if (wordWidth > safeWidth) {
      let remaining = word;
      while (terminalCellWidth(remaining) > safeWidth) {
        let cut = 0;
        for (const character of remaining) {
          if (terminalCellWidth(remaining.slice(0, cut + character.length)) > safeWidth) break;
          cut += character.length;
        }
        cut = Math.max(cut, 1);
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
      current = remaining;
      currentWidth = terminalCellWidth(remaining);
      continue;
    }
    current += word;
    currentWidth += wordWidth;
  }
  if (current || lines.length === 0) lines.push(current.replace(/\s+$/, ''));
  return lines;
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
  private waitingStartedAt = 0;
  private activityLines: string[] = [];
  private activityAnchor = 0;
  /** Lines back from the very end of the conversation. 0 means "showing the
   * latest" (the default, and where every repaint clamps back to if the
   * conversation is shorter than this). Deliberately a line count, not a
   * message index: paging by whole screens needs to know how many wrapped
   * lines actually fit, which messages alone don't tell you. */
  private historyScroll = 0;
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
    this.waitingStartedAt = Date.now();
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
    // The title used to share this line with provider/model/directory, which
    // meant a long title truncated whichever of those came after it — the
    // exact information you'd want intact regardless of how long the title
    // is. It gets its own line now (see titleText below).
    return [provider, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  /** The only other place a chat's title ever appeared was a transient line in
   * the /resume picker itself — once you were actually inside a resumed
   * conversation there was nothing on screen confirming which one, so
   * switching looked like it hadn't done anything even when the transcript
   * above had in fact changed. Right-aligned on its own line so it never
   * competes with statusText()'s provider/model/directory for space. */
  private titleText(): string | undefined {
    return this.currentSession?.name || undefined;
  }

  /** Elapsed time alongside the label -- matching a native CLI's own "Cogitated
   * for 5m 31s" style -- so a long turn reads as "still working, N seconds in"
   * rather than the same static label sitting there with no sense of how long
   * it's actually been (only the spinner glyph itself changing every 90ms). */
  private waitingText(): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.waitingStartedAt) / 1000));
    const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
    return `${frames[this.waitingFrame % frames.length]} ${this.waitingLabel} (${elapsed})`;
  }

  private updateWaiting(): void {
    if (!this.waitingLabel || !this.waitingScreenRow) return;
    // No -1 margin here: DEC autowrap is disabled for the whole frame this
    // row belongs to, so writing all the way to the terminal's real last
    // column is safe and doesn't trigger a wrap.
    const width = Math.max(12, output.columns || 100);
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
    // No -1 margin: DEC autowrap is off for this whole frame (see the
    // `[?7l` at the top of it), so the real last column is safe to
    // use, not just columns-1.
    const width = Math.max(12, output.columns || 100);
    const inner = width - 4;
    // The conversation transcript gets its own, tighter margin: a bare
    // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
    // on top of its own 4-column reservation (6 total) -- next to a native
    // CLI's own output, which runs close to the full terminal width with
    // only a bullet-and-space margin, ClikCode's wider gutter read as
    // noticeably narrower and "bleaker" for no real reason; this doesn't
    // touch inner itself, so the notice/composer/meta lines below (which
    // share it) are unaffected.
    const conversationInner = width - 2;
    const rule = chalk.dim('─'.repeat(width));
    const allMessages = session.messages ?? [];
    // 40, not 6: matches the same replay/adoption cap used elsewhere
    // (failoverPrompt, ADOPTED_TRANSCRIPT_LIMIT) and — now that the
    // conversation area supports scrolling — gives Page Up somewhere real to
    // go instead of a pool too small to scroll through at all.
    const messages = allMessages.slice(-40);
    const messageStart = allMessages.length - messages.length;
    const targetHeight = Math.max(4, (output.rows || 30) - 1);
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    const paletteCapacity = Math.min(requestedPaletteCapacity, Math.max(0, targetHeight - 5));
    const footerOnly = palette?.footerOnly ?? false;
    const paletteRows = paletteCapacity;
    const noticeRows = this.currentNotice ? 1 : 0;
    // 4 reserved lines below the conversation/palette/notice bands: rule,
    // composer, a second rule (with the chat's title embedded at its right
    // edge) — each newline-terminated — plus one further implicit row for
    // meta (provider/model/directory), deliberately the one line with no
    // trailing newline; see the comment on that write below for why.
    const rows = Math.max(1, targetHeight - 4 - paletteRows - noticeRows);
    const conversation: Array<{ text: string; waiting?: boolean }> = [];
    let activityAppended = false;
    const appendActivity = (): void => {
      if (activityAppended) return;
      activityAppended = true;
      for (const activity of this.activityLines) conversation.push({ text: `${chalk.dim('·')} ${activity}` });
      if (this.waitingLabel) conversation.push({ text: `${chalk.cyan('●')} ${chalk.dim(this.waitingText())}`, waiting: true });
    };
    for (const [messageIndex, message] of messages.entries()) {
      const marker = message.role === 'assistant' ? chalk.white('·') : chalk.white('›');
      let firstLine = true;
      for (const block of splitIntoBlocks(message.content)) {
        if (block.kind === 'code') {
          // Not word-wrapped -- re-flowing code would change what it means.
          // Hard-truncated instead, same as visibleSlice does for a single
          // overlong token elsewhere in this file.
          for (const codeLine of block.lines) {
            const prefix = firstLine ? `${marker} ` : '  ';
            conversation.push({ text: `${prefix}  ${chalk.cyan(visibleSlice(codeLine, Math.max(1, conversationInner - 2)))}` });
            firstLine = false;
          }
          continue;
        }
        const { prefix: bulletPrefix, hangIndent, text, bold, rule } = formatParagraph(block.paragraph || ' ');
        if (rule) {
          const prefix = firstLine ? `${marker} ` : '  ';
          conversation.push({ text: `${prefix}${chalk.dim('─'.repeat(Math.max(1, conversationInner)))}` });
          firstLine = false;
          continue;
        }
        const styled = renderInlineMarkdown(text);
        const budget = Math.max(1, conversationInner - terminalCellWidth(bulletPrefix || hangIndent));
        // conversationInner is already the full per-line budget after the
        // 2-column marker/indent prefix; wrapWords breaks at spaces (falling
        // back to a hard break only for a single word wider than the whole
        // line) instead of the flat character-count slice this replaced,
        // which split words wherever the count happened to land.
        const wrapped = wrapWords(styled, budget);
        for (const [lineIndex, line] of wrapped.entries()) {
          const prefix = firstLine ? `${marker} ` : '  ';
          const structural = lineIndex === 0 ? bulletPrefix : hangIndent;
          conversation.push({ text: `${prefix}${structural}${bold ? chalk.bold(line) : line}` });
          firstLine = false;
        }
      }
      conversation.push({ text: '' });
      if (messageStart + messageIndex + 1 === this.activityAnchor) appendActivity();
    }
    if (!activityAppended) appendActivity();
    // Clamped here (not just where scroll changes) because the available
    // content shifts underneath the same scroll value on every repaint: a
    // new message arriving grows `conversation`, a session switch can shrink
    // it out from under a scroll position that made sense for the old one.
    const maxScroll = Math.max(0, conversation.length - rows);
    this.historyScroll = Math.min(this.historyScroll, maxScroll);
    const windowStart = Math.max(0, conversation.length - rows - this.historyScroll);
    const shown = conversation.slice(windowStart, windowStart + rows);
    if (this.historyScroll > 0 && shown.length) {
      shown[0] = { text: `  ${chalk.dim(`── ${this.historyScroll} line${this.historyScroll === 1 ? '' : 's'} below · PgDn to catch up ──`)}` };
    }
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
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    const title = this.titleText();
    const titleSuffix = title ? ` ${visibleSlice(title, Math.max(0, width - 4))}` : '';
    const ruleWidth = Math.max(0, width - terminalCellWidth(titleSuffix));
    screenLine(`${chalk.dim('─'.repeat(ruleWidth))}${chalk.dim(titleSuffix)}`);
    // meta is the true last line: total frame height is exactly the terminal
    // height, so a newline after the very last line would land the cursor on
    // the last row and scroll the whole screen by one -- invisible in a
    // one-off full repaint (which starts over from \x1b[H next time), but
    // fatal for footerOnly/select() repaints, which jump back to a fixed
    // absolute row: every such scroll left that target one row stale, so the
    // old line was never overwritten, only added to -- the "adds a line
    // every time you scroll" reports in the palette and pickers.
    frame += `\r\x1b[2K  ${chalk.dim(visibleSlice(meta, inner))}\x1b[?7h`;
    if (!palette?.hideCursor) frame += `\x1b[2A\r\x1b[${2 + terminalCellWidth(prompt) + viewport.cursorWidth}C\x1b[?25h`;
    output.write(frame);
  }

  question(prompt: string, commands: readonly PickerOption<string>[] = [], settings?: { cancellable?: boolean }): Promise<string> {
    if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    return new Promise((resolveQuestion, rejectQuestion) => {
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
      // No .slice(0, 8) here: that used to cap the real match list itself,
      // not just what's visible at once, so typing "/" (matching every
      // command) could never scroll to anything past the 8th regardless of
      // how far down you pressed -- selected's own wraparound never saw
      // past index 7 because options.length itself was capped there. The
      // windowed scroll in paint() below already exists specifically to
      // show a scrollable slice of a longer list; capping the list before
      // it ever got there defeated that.
      const matches = () => value.startsWith('/') && !value.includes(' ')
        ? commands.filter((option) => option.value.startsWith(value))
        : [];
      // Scrolling the conversation needs the full paint() path — the normal
      // (no-palette) branch below only ever touches the composer's own line
      // for performance, so a scroll action changing what's shown *above* the
      // composer would otherwise never actually repaint, which is exactly
      // what silently ate the first attempt at this: the key was received
      // and historyScroll did change, nothing on screen ever reflected it.
      const draw = (forceFullRepaint = false): void => {
        const options = matches();
        if (selected >= options.length) selected = 0;
        if (options.length || showedPalette) {
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity, footerOnly: paletteOpen });
          paletteOpen = true;
          this.paletteActive = true;
        } else if (forceFullRepaint) {
          // No real palette here — pass no palette config at all, otherwise
          // paint() would size a footer band for one anyway (its own
          // capacity default comes from the full slash-command list, not
          // "is a palette actually showing").
          this.paint(value, [], 0, prompt, cursor);
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
      // Opt-in, not a default: this same question() drives the persistent
      // chat composer too, where Esc doing nothing is the existing,
      // intentional behavior (there's nothing to "cancel" mid-draft the way
      // there is for a one-off prompt). Callers that need real cancel
      // semantics -- like the API-key env-var-name prompt, previously
      // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
      // { cancellable: true } and get a real rejection to catch, instead of
      // an empty string indistinguishable from "accepted the default".
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        input.off('data', onData);
        input.setRawMode(false);
        output.write('\u001b[?25h');
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      const handleKey = (key: string): void => {
        const options = matches();
        if (key === '\u0003' || key === '\u0004') return finish('/exit');
        if (key === '\u001b' && settings?.cancellable) return cancel();
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
        // Plain Up/Down scroll the conversation now, not prompt history: a
        // swipe gesture or a terminal app's own on-screen scrollbar (common
        // on mobile SSH clients, which is how this was actually being tried)
        // sends exactly these two sequences, nothing else -- Page Up/Down
        // below is real and works from a physical keyboard, but was
        // unreachable from a touch interface, which is what "I can see the
        // scrollbar but the chat doesn't move, even using the scrollbar
        // itself" was: the keys arrived, but at prompt-history recall, which
        // silently did nothing when there was no history yet to recall.
        // Prompt history moves to Ctrl+P/Ctrl+N (common readline-style
        // bindings) so it isn't lost, just no longer on the key that has to
        // mean "scroll" for a touch interface to be usable at all.
        if (key === '\u001b[A') {
          if (options.length) { selected = (selected - 1 + options.length) % options.length; return draw(); }
          this.historyScroll += 3;
          return draw(true);
        }
        if (key === '\u001b[B') {
          if (options.length) { selected = (selected + 1) % options.length; return draw(); }
          this.historyScroll = Math.max(0, this.historyScroll - 3);
          return draw(true);
        }
        if (key === '\u0010' && !options.length) { if (historyIndex > 0) { historyIndex--; value = this.history[historyIndex] ?? ''; cursor = value.length; } return draw(); }
        if (key === '\u000e' && !options.length) { historyIndex = Math.min(this.history.length, historyIndex + 1); value = this.history[historyIndex] ?? ''; cursor = value.length; return draw(); }
        if (key === '\u001b[D') { cursor = previousCharacterIndex(value, cursor); return draw(); }
        if (key === '\u001b[C') { cursor = nextCharacterIndex(value, cursor); return draw(); }
        // Page Up/Down scroll by a full page instead of 3 lines, for a real
        // keyboard's own dedicated keys.
        if (key === '\u001b[5~') { this.historyScroll += 10; return draw(true); }
        if (key === '\u001b[6~') { this.historyScroll = Math.max(0, this.historyScroll - 10); return draw(true); }
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
        const keys = String(chunk).match(/\u001b\[[ABCD]|\u001b\[[56]~|[\s\S]/g) ?? [];
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
  /** Type-to-filter: a picker with more than a screenful of options (the
   * /resume list, across every ClikCode session plus every discovered vendor
   * chat, easily exceeds 50) was arrow-keys-only with no count, no scroll
   * indicator, and silent wraparound at each end -- a real conversation could
   * sit in the middle of a list that long and be effectively unfindable by
   * scrolling alone. Letters/digits/space now narrow the list live by
   * substring match against label and detail (title, provider, status);
   * arrow keys still navigate whatever is currently visible. This is why the
   * old 'j'/'k'/'q' single-letter aliases are gone: they would collide with
   * typing a real filter query character (searching for "qwen" or "junk"). */
  select<T>(title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>): Promise<T | undefined> {
    if (!options.length) return Promise.resolve(undefined);
    return new Promise((resolveSelection) => {
      this.selecting = true;
      let query = '';
      let selected = 0;
      let painted = false;
      const capacity = Math.min(options.length, 8) + 2;
      const visibleOptions = (): readonly PickerOption<T>[] => {
        if (!query) return options;
        const needle = query.toLowerCase();
        return options.filter((option) =>
          option.label.toLowerCase().includes(needle) || (option.detail ?? '').toLowerCase().includes(needle));
      };
      const draw = (): void => {
        const visible = visibleOptions();
        if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
        const renderOptions = visible.map((option) => ({ label: option.label, detail: option.detail, value: '' }));
        const hint = query
          ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} \u00b7 \u2191\u2193 move \u00b7 Enter choose \u00b7 Esc clear`
          : `${options.length} total \u00b7 \u2191\u2193 move \u00b7 Enter choose \u00b7 Esc cancel \u00b7 type to filter`;
        this.paint(title, renderOptions, selected, '', 0, { capacity, footerOnly: painted, hideCursor: true, hint });
        painted = true;
      };
      let finished = false;
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.selecting = false;
        input.off('data', onData);
        input.setRawMode(false);
        this.paint('', [], 0, '\u203a ', 0);
        resolveSelection(value);
      };
      // Right arrow, not Enter, opens an option's own actions (disconnect,
      // reauthenticate, ...) -- only when it actually declares any,
      // otherwise this is a no-op so every existing picker that never sets
      // `actions` is completely unaffected. Runs a small nested select() for
      // the action list itself, pausing this picker's own key handling
      // while it's open (both would otherwise react to the same keypress --
      // Node lets multiple 'data' listeners stack) and redrawing this
      // picker's own view once it's done, since the nested call's own
      // cleanup repaints the plain composer over top of it.
      const openActions = async (option: PickerOption<T>): Promise<void> => {
        if (!option.actions?.length) return;
        input.off('data', onData);
        const actionValue = await this.select(option.label, option.actions.map((action) => ({ label: action.label, value: action.value })));
        if (finished) return;
        if (actionValue) await onAction?.(option.value, actionValue);
        if (finished) return;
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        draw();
      };
      const handleKey = (key: string): void => {
        const visible = visibleOptions();
        if (key === '\u001b[A') selected = visible.length ? (selected - 1 + visible.length) % visible.length : 0;
        else if (key === '\u001b[B') selected = visible.length ? (selected + 1) % visible.length : 0;
        else if (key === '\u001b[C') { if (visible[selected]) void openActions(visible[selected]); return; }
        else if (key === '\r' || key === '\n') { if (visible[selected]) finish(visible[selected].value); return; }
        else if (key === '\u0003') return finish(undefined);
        else if (key === '\u001b') { if (query) { query = ''; selected = 0; } else return finish(undefined); }
        else if (key === '\u007f' || key === '\b') { if (!query) return; query = query.slice(0, -1); selected = 0; }
        else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
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
  async suspend(): Promise<void> {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
    // Best-effort mitigation, not a confirmed root cause: a vendor login's
    // own paste handling erroring right after handoff is plausibly a race
    // between the terminal actually finishing its mode switch (raw -> cooked,
    // alt-screen -> main buffer) and the child process starting to read --
    // both writes above are fire-and-forget from Node's side, with no way to
    // know when the terminal itself has caught up. A short settle window
    // before the caller spawns anything costs nothing on the success path
    // and closes the gap if that race is real.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
  }

  resume(): void {
    if (this.closed) return;
    // \x1b[2J explicitly clears the whole alt-screen buffer before painting
    // -- suspend() hands control to the real terminal for a login prompt,
    // and the terminal's actual dimensions can genuinely change in that
    // window (most plausibly a mobile SSH client's on-screen keyboard
    // appearing/disappearing). Every other repaint in this file only clears
    // the exact lines it's about to rewrite (screenLine's \x1b[2K on each
    // line as the cursor advances), which is fine when the frame height is
    // stable between paints, but would leave old content below a shorter
    // new frame -- e.g. an old meta/status line -- never revisited. That's
    // the concrete "meta line duplicates after switching providers" report
    // this fixes: switching to a provider needing login is exactly the
    // path that goes through suspend/resume.
    output.write('\u001b[?1049h\u001b[2J');
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
      ['/account', 'choose or view an account'],
      ['/add-account', 'log in and add another account for this provider'],
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

/** Reads real account info out of a harness's own credential storage right
 * after login -- verified so far only for Claude Code, whose
 * ~/.claude/.credentials.json (or the isolated profile path, if this
 * harness supports multiple accounts) carries a real `subscriptionType`
 * field (checked directly against a live file earlier: no email/name field
 * exists there, but the subscription tier does, and it's real account
 * info, not a guess). Returns undefined -- never a fabricated name -- for
 * every harness without a confirmed credential shape to read, which is
 * every other one right now; the numbered placeholder below covers those.
 */
async function deriveAccountLabel(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  if (harness.command === 'claude') {
    try {
      const path = join(profilePath ?? join(homedir(), '.claude'), '.credentials.json');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (!token) return undefined;
      // subscriptionType duplicated the provider's own display name right
      // next to itself ("Claude Code (pro)" sitting beside "Claude Code" in
      // the status line and picker) without actually distinguishing one
      // account from another with the same plan. /api/oauth/profile is a
      // real endpoint (verified directly: returns this exact token's own
      // account.email) -- and since the token itself is already confirmed
      // profile-scoped (it comes from this account's own, possibly
      // CLAUDE_CONFIG_DIR-isolated, credentials file), the email it returns
      // is guaranteed specific to *this* account, not shared across every
      // Claude Code account the way a file outside that isolated directory
      // (~/.claude.json, sibling to the redirectable ~/.claude/ folder --
      // checked, and its own OAuth path isn't confirmed to move with
      // CLAUDE_CONFIG_DIR) would have been.
      const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { account?: { email?: string } };
      return typeof body.account?.email === 'string' && body.account.email ? body.account.email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'codex') {
    try {
      const path = join(profilePath ?? join(homedir(), '.codex'), 'auth.json');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { tokens?: { id_token?: string } };
      const idToken = parsed.tokens?.id_token;
      if (!idToken) return undefined;
      // No API call needed here, unlike Claude: Codex's id_token is a
      // standard OIDC JWT and its payload already carries a real `email`
      // claim directly -- verified against this exact file's own token.
      // Decoding the payload to read a claim isn't the same as verifying
      // the token's signature (not needed here; this is read-only display
      // of a claim from a credential file already trusted enough to
      // authenticate real requests with), and the payload segment is
      // profile-scoped the same way the whole auth.json file is (CODEX_HOME
      // isolation, verified from this catalog entry's own profileEnv).
      const payload = idToken.split('.')[1];
      if (!payload) return undefined;
      const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as { email?: string };
      return typeof claims.email === 'string' && claims.email ? claims.email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  if (harness.command === 'cursor') {
    // Simplest of the three so far: no token to decode, no API call --
    // ~/.cursor/cli-config.json carries a real, plain-text authInfo.email
    // field directly. No profileEnv exists for Cursor (confirmed against
    // its own catalog entry), so this file is always at the one fixed path
    // regardless of account -- meaning, same as Gemini/OpenCode/Amp, only
    // one real Cursor identity can be tracked at a time today; this just
    // means that one identity shows correctly instead of as "Cursor Agent
    // default".
    try {
      const parsed = JSON.parse(await readFile(join(homedir(), '.cursor', 'cli-config.json'), 'utf8')) as { authInfo?: { email?: string } };
      const email = parsed.authInfo?.email;
      return typeof email === 'string' && email ? email : undefined;
    } catch { /* fail-open-ok: no derivable info beats a fabricated name. */ }
  }
  return undefined;
}

/** Starts the vendor-owned login flow and records only a local opaque profile reference.
 * With no explicit label, the final name is decided *after* login completes: a
 * numbered placeholder is picked first (so an explicit-label caller and duplicate
 * checks upfront still behave as before), but if deriveAccountLabel finds real
 * account info once the credential file actually exists, that replaces the
 * placeholder -- removing the old interactive "Account name [...]" prompt this
 * used to require without falling back to an arbitrary made-up name. */
export async function aiAccountLogin(harnessCommandName: string, label?: string): Promise<string> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const placeholder = `${harness.displayName} ${existingForProvider + 1}`;
  const explicit = label?.trim();
  let accountLabel = explicit || placeholder;
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
  if (!explicit) {
    const derived = await deriveAccountLabel(harness, profilePath);
    if (derived) {
      // A derived identity matching an account that already exists means
      // this is the SAME real account signing in again -- not a new one --
      // even though the login flow just created a brand-new isolated
      // profile directory to get here (there's no way to know who's behind
      // a login before actually completing it). Previously this only
      // skipped renaming to the derived label in that case and fell
      // through to pushing a duplicate anyway under the numbered
      // placeholder -- the exact "logged in with the same email, it
      // created a new one and left the old one" bug. Now it reuses the
      // existing account outright: repoints its nativeProfile at the fresh
      // login (the old profile directory may be stale/expired) instead of
      // creating anything new, and the just-created directory above is
      // simply orphaned rather than referenced by two accounts.
      const existingMatch = state.accounts.find((account) => account.provider === harness.provider && account.label.toLowerCase() === derived.toLowerCase());
      if (existingMatch) {
        existingMatch.status = 'ready';
        if (nativeProfile) existingMatch.nativeProfile = nativeProfile;
        await writeState(state);
        emitHarnessOutput({ status: 'connected', harness: harness.command, account: existingMatch.label, credentialBoundary: 'local-only' });
        return existingMatch.label;
      }
      accountLabel = derived;
    }
  }
  if (!state.accounts.some((account) => account.label.toLowerCase() === accountLabel.toLowerCase())) {
    state.accounts.push({ id: accountId, provider: harness.provider, label: accountLabel, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${harness.binary}`, ...(nativeProfile ? { nativeProfile } : {}) });
    await writeState(state);
  }
  emitHarnessOutput({ status: 'connected', harness: harness.command, account: accountLabel, credentialBoundary: 'local-only' });
  return accountLabel;
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
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (activeFullScreenHarness && harness.loginArgv) {
    const environment = account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
    if (freshInstall || await harnessNeedsLogin(harness, environment)) {
      activeFullScreenHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
      await activeFullScreenHarness.suspend();
      try {
        await loginNativeHarness(harness, environment);
      } finally {
        activeFullScreenHarness.resume();
      }
      // Only rename if it's still the generic placeholder -- a user who's
      // already renamed this account to something of their own gets to
      // keep it; this only fixes the case this whole thing is about: a
      // first-ever /provider login (not /add-account, which already
      // derives this before the account exists at all) leaving "X default"
      // in place forever afterward, since this account already existed
      // before login and the auto-creation branch above never runs again
      // for it.
      if (account && account.label === `${harness.displayName} default`) {
        const derived = await deriveAccountLabel(harness, account.nativeProfile?.path);
        if (derived && !state.accounts.some((item) => item.id !== account.id && item.label.toLowerCase() === derived.toLowerCase())) {
          account.label = derived;
          await writeState(state);
        }
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
  // A session that never received a single turn AND was never linked to a
  // real vendor conversation has nothing to resume — keeping it as "closed"
  // clutter buries real conversations under identical "Untitled chat" entries
  // every time the app is opened and exited without typing anything. Drop it
  // outright instead of accumulating it. A set nativeSessionId is kept even
  // with zero ClikCode-tracked messages: it may be adopted from, or linked
  // directly to, a vendor's own conversation that has real content ClikCode
  // just never routed a turn through.
  if (!(session.messages ?? []).length && !session.nativeSessionId) {
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

/** actions is deliberately narrow -- a plain label/value pair, not a full
 * nested PickerOption -- since it's rendered by select()'s own generic
 * right-arrow handler for *any* picker, not something built per-caller.
 * A caller (e.g. the account picker) that wants "disconnect"/"reauthenticate"
 * attaches them here; select() has no idea what they mean, it just shows
 * them and returns whichever one was chosen. */
interface PickerOption<T> { label: string; detail?: string; value: T; actions?: readonly { label: string; value: string }[] }

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

/** Shared by both the /account picker's "Add another account…" entry and
 * /add-account's direct path: suggest a name, take it or a typed override,
 * run the vendor login, then make the new account the current one for this
 * session. The two entry points differ only in how `harness` gets chosen --
 * everything after that is identical. */
/** Well-known SDK/CLI environment variable names each vendor's own tooling
 * already looks for -- not invented here, just the standard name suggested
 * as a starting point for the env var prompt below. Falls back to a
 * generic <PROVIDER>_API_KEY guess for anything not in this short list. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', qwen: 'DASHSCOPE_API_KEY',
};

async function addApiKeyAccount(rl: HarnessPrompter, id: string, harness: AiLocalHarnessDefinition): Promise<void> {
  const suggested = PROVIDER_API_KEY_ENV[harness.provider] ?? `${harness.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  let entered: string;
  try {
    entered = (await rl.question(`Environment variable holding the key ${chalk.dim(`[${suggested}]`)} › `, [], { cancellable: true })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_CANCELLED') return;
    throw error;
  }
  const envName = (entered || suggested).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error('environment variable name must be letters, numbers, and underscores only');
  if (!process.env[envName]) throw new Error(`${envName} is not set in this shell -- export it first, then try again. ClikCode never asks for or stores the raw key itself, only this reference.`);
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const label = `${harness.displayName} (${envName})`;
  await aiAccountAdd({ provider: harness.provider, label: state.accounts.some((account) => account.label === label) ? `${label} ${existingForProvider + 1}` : label, auth: 'api-key', credentialRef: `env:${envName}` });
  await aiSessionCommand(id, `/settings account ${label}`);
}

async function addAccountForHarness(rl: HarnessPrompter, id: string, harness: AiLocalHarnessDefinition): Promise<void> {
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
  if (!authKind) return;
  if (authKind === 'api-key') {
    await addApiKeyAccount(rl, id, harness);
    return;
  }
  // No name prompt: aiAccountLogin picks a numbered placeholder up front and
  // replaces it with something derived from the harness's own credentials
  // once login actually completes, wherever that's possible -- one less
  // step than asking the user to type or confirm a name themselves.
  const label = await aiAccountLogin(harness.command);
  await aiSessionCommand(id, `/settings account ${label}`);
}

/** The direct path: skips the harness picker entirely when the current
 * session already has a provider, since asking "which provider?" again is
 * exactly the extra step this command exists to cut -- you're already in
 * one. Only falls back to picking a harness for a session that has none
 * yet (a brand-new chat with nothing chosen), where there's genuinely no
 * "current provider" to default to. */
async function interactiveAddAccount(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (current) {
    await addAccountForHarness(rl, id, current);
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
  await addAccountForHarness(rl, id, localHarnessForCommand(harnessCommand)!);
}

/** /provider switches providers; /account switches accounts -- so once a
 * session already has a provider, this only ever shows accounts for that
 * one provider, never a cross-provider list to pick through. A session
 * with no provider yet (nothing to filter to) falls back to every ready
 * account, sorted so accounts sharing a provider stay adjacent -- the
 * closest thing to "grouped" without inventing a non-selectable header row
 * this picker has no concept of. */
/** Disconnect/reauthenticate only ever offered per harness capability, same
 * principle as everywhere else in this file that normalizes against a
 * vendor's declared catalog fields instead of assuming every harness works
 * the same way: Disconnect needs a real logoutArgv to actually run (Claude
 * Code has one; several harnesses don't), reauthenticate needs loginArgv.
 * Disconnect signs the account out (status -> needs_login) rather than
 * deleting it, specifically so it stays visible here afterward with
 * somewhere to reauthenticate it back to ready from -- deleting it here
 * would have made "reauthenticate a disconnected account" unreachable. */
async function interactiveAccountPicker(rl: HarnessPrompter, id: string): Promise<void> {
  for (;;) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const currentHarness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    const vendorAccounts = state.accounts.filter((account) => account.authKind === 'vendor-cli');
    const accounts = (currentHarness ? vendorAccounts.filter((account) => account.provider === currentHarness.provider) : vendorAccounts)
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label));
    // No usage preview here on purpose: it used to await accountUsageLabel
    // (a real network call per account) before this picker could show
    // anything at all -- the exact "a slash option takes a few seconds to
    // render" complaint, just in a second picker beyond /provider. Usage is
    // already visible in the persistent status line the moment an account
    // is actually active; a list you're choosing *from* doesn't need to
    // block on it too.
    let actionPerformed = false;
    const selected = await chooseOption(rl, currentHarness ? `Choose a ${currentHarness.displayName} account` : 'Choose an account', [
      ...accounts.map((account) => {
        const harness = localHarnessForProvider(account.provider);
        const actions = [
          ...(harness?.logoutArgv && account.status === 'ready' ? [{ label: 'Disconnect', value: 'disconnect' }] : []),
          ...(harness?.loginArgv && account.status !== 'ready' ? [{ label: 'Reauthenticate', value: 'reauthenticate' }] : []),
        ];
        return {
          label: account.label,
          // Provider only shown in the detail when the list actually spans
          // more than one (i.e. no currentHarness to have already filtered
          // to it) -- otherwise it's the exact redundant "provider name
          // shown again right next to itself" this replaced.
          detail: `${currentHarness ? '' : `· ${harness?.displayName ?? account.provider} `}${account.status !== 'ready' ? `· ${chalk.yellow('needs sign-in')} ` : ''}${account.quotaState === 'exhausted' ? `· ${chalk.yellow('quota exhausted')} ` : ''}${account.id === session.accountId ? '· current' : ''}${actions.length ? ` ${chalk.dim('(→ for options)')}` : ''}`.trim(),
          value: account.label,
          actions,
        };
      }),
      { label: 'Add another account…', detail: 'vendor login', value: '__add__' },
    ], async (label, action) => {
      actionPerformed = true;
      const account = state.accounts.find((item) => item.label === label);
      const harness = account ? localHarnessForProvider(account.provider) : undefined;
      if (!account || !harness) return;
      const environment = account.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
      if (action === 'disconnect' && harness.logoutArgv) {
        await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
        account.status = 'needs_login';
        await writeState(state);
      } else if (action === 'reauthenticate' && harness.loginArgv) {
        if (rl instanceof FullScreenHarnessPrompter) {
          await rl.suspend();
          try { await loginNativeHarness(harness, environment); } finally { await rl.resume(); }
        } else {
          await loginNativeHarness(harness, environment);
        }
        account.status = 'ready';
        await writeState(state);
      }
    });
    if (actionPerformed) continue;
    if (!selected) return;
    if (selected !== '__add__') {
      await aiSessionCommand(id, `/settings account ${selected}`);
      return;
    }
    await interactiveAddAccount(rl, id);
    return;
  }
}


async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string; adopted: boolean } | undefined> {
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
  const discoverable = localRouter().AI_LOCAL_HARNESSES.filter((harness) => harness.session?.discoverArgv);
  const shellDiscovered = (await Promise.all(discoverable.map(async (harness) => {
    const account = state.accounts.find((item) => item.provider === harness.provider && item.status === 'ready');
    const environment = account?.nativeProfile ? { [account.nativeProfile.env]: account.nativeProfile.path } : {};
    const found = await discoverNativeSessions(harness, environment, workspace);
    return found.map((item) => ({ harness, item }));
  }))).flat();
  const fsDiscovered = (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    const found = await discover(workspace).catch(() => []);
    return found.map((item) => ({ harness, item }));
  }))).flat();
  const discovered = [...shellDiscovered, ...fsDiscovered]
    .filter(({ harness, item }) => !state.sessions.some((session) => session.nativeHarness === harness.command && session.nativeSessionId === item.nativeId));
  // Every option gets a single real recency key so the newest conversation is
  // always near the top regardless of which source found it — grouping by
  // source first (every ClikCode session, then every opencode result, then
  // every Hermes result, ...) buried a two-minutes-old live Claude Code
  // session below Hermes entries from June, since each *group* was sorted
  // internally but the groups themselves were never interleaved. A source
  // with no real timestamp (an unparsed vendor display string) sorts last
  // rather than claiming a false position.
  const options: Array<PickerOption<string> & { sortKey: number }> = [
    ...sessions.map((session) => {
      const model = session.model && session.nativeHarness === 'claude'
        ? CLAUDE_ALIAS_LABELS[session.model] ?? session.model
        : session.model;
      const sortKey = Date.parse(session.updatedAt);
      return {
        label: `${sessionProviderLabel(session)} • ${session.name ?? 'Untitled chat'}`,
        detail: `· ${session.id === currentId ? 'current · ' : ''}${model ?? 'automatic'} · ${session.status} · ${new Date(session.updatedAt).toLocaleString()}`,
        value: session.id,
        sortKey: Number.isNaN(sortKey) ? -Infinity : sortKey,
      };
    }),
    ...discovered.map(({ harness, item }) => ({
      label: `${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
      detail: `· not yet in ClikCode${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
      value: `native:${harness.command}:${item.nativeId}`,
      sortKey: item.updatedAtMs ?? -Infinity,
    })),
  ];
  options.sort((left, right) => right.sortKey - left.sortKey);
  const selected = await chooseOption(rl, 'Resume a session', options);
  if (!selected) return undefined;
  if (!selected.startsWith('native:')) return { id: selected, adopted: false };
  const rest = selected.slice('native:'.length);
  const separator = rest.indexOf(':');
  const harnessCommand = rest.slice(0, separator);
  const nativeId = rest.slice(separator + 1);
  const match = discovered.find((entry) => entry.harness.command === harnessCommand && entry.item.nativeId === nativeId);
  if (!match) return undefined;
  const account = state.accounts.find((item) => item.provider === match.harness.provider && item.status === 'ready');
  const defaults = resolveDefaultSettings(state, match.harness.provider);
  const now = new Date().toISOString();
  // The vendor's own thread already has full context regardless — adopting
  // its identity alone is enough for continuation to work correctly the
  // moment a turn is sent. Populating ClikCode's own transcript view too is a
  // separate, best-effort read: only wired for the harnesses with a confirmed
  // way to read a whole conversation back out (see ADOPTED_TRANSCRIPT_READERS
  // above), and never something continuation itself depends on.
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader ? await transcriptReader(match.harness, nativeId, workspace).catch(() => []) : [];
  const adopted: HarnessSession = {
    id: randomUUID(), route: 'local', accountId: account?.id ?? null, provider: match.harness.provider,
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
  return { id: adopted.id, adopted: true };
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
    '/provider': 'choose a provider (including ClikDeploy Gateway)', '/settings': 'configure this workspace', '/account': 'choose or view an account',
    '/add-account': 'log in and add another account for this provider',
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
        else if (command === '/account' || command === '/accounts') await interactiveAccountPicker(rl, id);
        else if (command === '/add-account' || command === '/addaccount') await interactiveAddAccount(rl, id);
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
            // Resuming picks up a conversation's content, not necessarily its
            // original vendor: staying on whatever you're already running is
            // the point of switching providers in the first place — reopening
            // an old chat shouldn't silently pull you back to a different one.
            // A session freshly adopted from a vendor's own history (picked by
            // that vendor's name, e.g. "OpenCode • Test message") is the one
            // exception: that choice already names the provider you want, and
            // forcing it onto the current one would immediately discard the
            // native session id just adopted.
            if (!selected.adopted) {
              const resumeState = await readState();
              const current = resumeState.sessions.find((item) => item.id === id);
              const target = resumeState.sessions.find((item) => item.id === selected.id);
              if (current?.nativeHarness && target && target.nativeHarness !== current.nativeHarness) {
                const originalLabel = sessionProviderLabel(target);
                const hasContent = (target.messages ?? []).length > 0;
                target.nativeHarness = current.nativeHarness;
                target.provider = current.provider;
                target.accountId = current.accountId;
                target.model = null;
                target.nativeSessionId = undefined;
                target.nativeStartedAt = undefined;
                // A title inherited from the old provider's conversation is
                // only meaningful alongside that conversation's actual
                // messages. Wiping the native session id above already
                // discards the old provider's identity; leaving a title with
                // nothing behind it produced a real, reported bug — a chat
                // that "shows a title but never loads," because there was
                // never anything to load once the messages were gone (a
                // session adopted with no readable transcript, most often).
                if (!hasContent) target.name = undefined;
                target.updatedAt = new Date().toISOString();
                await writeState(resumeState);
                notice = hasContent
                  ? `Continuing this ${originalLabel} chat under ${sessionProviderLabel(current)}.`
                  : `Starting fresh under ${sessionProviderLabel(current)} — this ${originalLabel} chat had no readable history to bring over.`;
              }
            }
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
          const environment = selectedAccount?.nativeProfile ? { [selectedAccount.nativeProfile.env]: selectedAccount.nativeProfile.path } : {};
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
            const textPhase = nativeActivityPhase(harness, lineText);
            if (textPhase) activeFullScreenHarness?.phase(textPhase);
            // isJsonDefaultMode() guard lives here now (not inside the parser)
            // since the parser is also used for phase updates, which apply
            // in every mode -- only the persistent activity *log line* is
            // JSON-mode's business to suppress.
            const event = parseNativeActivityEvent(harness, lineText);
            if (!event) return;
            activeFullScreenHarness?.phase(renderActivityPhase(event));
            if (isJsonDefaultMode()) return;
            const activityLines = renderActivityLine(event);
            for (const activity of activityLines) {
              if (activeFullScreenHarness) activeFullScreenHarness.activity(activity.trim());
              else output.write(`${activity}\n`);
            }
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
            activeFullScreenHarness.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
            await activeFullScreenHarness.suspend();
            try {
              await loginNativeHarness(harness, environment);
            } finally {
              activeFullScreenHarness.resume();
            }
            account.status = 'ready';
            await writeState(state);
            continue;
          }
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
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; label?: string; kind?: 'thinking' | 'tool-start'; tool?: string };
        if (event.type === 'delta' && typeof event.text === 'string') {
          activeFullScreenHarness?.phase('generating response');
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
            for (const line of renderActivityLine(activityEvent)) activeFullScreenHarness?.activity(line.trim());
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
