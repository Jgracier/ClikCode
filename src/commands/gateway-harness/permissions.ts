/** The permission decision for one tool call, the persisted allow rules that
 * feed it, and the approval text a human sees. Pure apart from the settings
 * file helpers at the bottom. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchGlob } from './glob-match.js';
import {
  classifyCommand, OUTPUT_CAPS, readDenyReason, resolvePath, writeDenyReason, type PathScope, type ResolvedPath,
} from './security.js';
import type { AiHarnessPermissionMode, ToolContext, ToolDefinition } from './types.js';

export type PermissionVerdict = 'allow' | 'ask' | 'deny';
export interface PermissionDecision { decision: PermissionVerdict; reason: string }

export interface PermissionRule { tool: string; specifier?: string; raw: string }
export interface PermissionRules { allow: readonly PermissionRule[] }

export const NO_RULES: PermissionRules = { allow: [] };
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode';
export const BASH_TOOL = 'bash';

/** `Bash(git status:*)`, `Edit(src/**)`, `WebFetch(domain:example.com)`, or a
 * bare tool name. Returns undefined for anything malformed. */
export function parsePermissionRule(raw: string): PermissionRule | undefined {
  const match = /^\s*([A-Za-z_][\w.-]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(raw);
  if (!match) return undefined;
  const specifier = match[2]?.trim();
  return { tool: match[1], raw: raw.trim(), ...(specifier ? { specifier } : {}) };
}

export function parsePermissionRules(values: unknown): PermissionRules {
  const list = Array.isArray(values) ? values : [];
  return { allow: list.flatMap((value) => typeof value === 'string' ? (parsePermissionRule(value) ?? []) : []) };
}

/** Rule families → the tool classes/names they cover. */
function ruleCoversTool(rule: PermissionRule, tool: ToolDefinition): boolean {
  const family = rule.tool.toLowerCase();
  if (family === tool.name.toLowerCase()) return true;
  if (family === 'bash') return tool.name === BASH_TOOL;
  if (family === 'edit' || family === 'write') return tool.class === 'write';
  if (family === 'read') return tool.class === 'read';
  if (family === 'webfetch') return tool.class === 'network';
  return false;
}

const UNSPLITTABLE = /[`$<>(){}\n\r\\]|&(?!&)/;

function bashSpecifierMatches(specifier: string, simpleCommand: string): boolean {
  if (specifier === '*') return true;
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim();
    return simpleCommand === prefix || simpleCommand.startsWith(`${prefix} `);
  }
  return simpleCommand === specifier;
}

/** A rule only ever vouches for a SIMPLE command. `git status && rm -rf x`
 * must not ride in on `Bash(git status:*)`: every segment of a compound
 * command has to be covered (by a rule or by the read-only classifier), and
 * anything with substitution or redirection is never rule-matched. */
function bashCommandAllowedByRules(command: string, rules: readonly PermissionRule[], scope: PathScope): boolean {
  const text = command.trim();
  if (!text || UNSPLITTABLE.test(text.replace(/&&/g, ';'))) return false;
  const segments = text.split(/&&|\|\||;|\|/).map((segment) => segment.trim());
  if (segments.some((segment) => !segment)) return false;
  let matchedAny = false;
  for (const segment of segments) {
    if (rules.some((rule) => bashSpecifierMatches(rule.specifier ?? '*', segment))) { matchedAny = true; continue; }
    if (classifyCommand(segment, scope).tier !== 'safe') return false;
  }
  return matchedAny;
}

function pathRuleMatches(specifier: string, resolved: ResolvedPath, scope: PathScope): boolean {
  if (specifier === '*' || specifier === '**') return resolved.confined;
  const pattern = specifier.replace(/^\.\//, '');
  if (path.isAbsolute(pattern) || pattern.startsWith('~')) {
    const absolutePattern = pattern.startsWith('~') ? path.join(scope.homeDir, pattern.slice(1)) : pattern;
    return matchGlob(absolutePattern.split(path.sep).join('/'), resolved.real.split(path.sep).join('/'));
  }
  if (!resolved.root) return false;
  return matchGlob(pattern, path.relative(resolved.root, resolved.real).split(path.sep).join('/'));
}

function hostOf(url: unknown): string | undefined {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return undefined; }
}

export interface PermissionRequest {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  mode: AiHarnessPermissionMode;
  rules: PermissionRules;
  planMode: boolean;
  scope: PathScope;
  /** False when no onApproval callback is attached: `ask` becomes `deny`. */
  hasApprover: boolean;
}

function allowedByRules(request: PermissionRequest, resolved: readonly ResolvedPath[]): boolean {
  const rules = request.rules.allow.filter((rule) => ruleCoversTool(rule, request.tool));
  if (!rules.length) return false;
  if (request.tool.name === BASH_TOOL) return bashCommandAllowedByRules(String(request.args.command ?? ''), rules, request.scope);
  if (request.tool.class === 'network') {
    const host = hostOf(request.args.url);
    return rules.some((rule) => {
      if (!rule.specifier || rule.specifier === '*') return true;
      const domain = rule.specifier.replace(/^domain:/, '').toLowerCase();
      return !!host && (host === domain || host.endsWith(`.${domain}`));
    });
  }
  if (!resolved.length) return rules.some((rule) => !rule.specifier || rule.specifier === '*');
  return resolved.every((entry) => rules.some((rule) => pathRuleMatches(rule.specifier ?? '*', entry, request.scope)));
}

function decide(request: PermissionRequest): PermissionDecision {
  const { tool, args, mode, planMode, scope } = request;
  let resolved: ResolvedPath[];
  try { resolved = (tool.paths?.(args) ?? []).map((entry) => resolvePath(entry, scope)); } catch (error) {
    return { decision: 'deny', reason: error instanceof Error ? error.message : 'invalid path' };
  }

  // 1. Hard denies hold in every mode, bypass included.
  if (tool.class === 'write') {
    for (const entry of resolved) { const reason = writeDenyReason(entry, scope); if (reason) return { decision: 'deny', reason }; }
  }
  if (tool.class === 'read') {
    for (const entry of resolved) { const reason = readDenyReason(entry, scope); if (reason) return { decision: 'deny', reason }; }
  }
  const command = tool.name === BASH_TOOL ? classifyCommand(String(args.command ?? ''), scope) : undefined;
  if (command?.tier === 'deny') return { decision: 'deny', reason: `blocked as dangerous: ${command.reason}` };

  // 2. Plan mode: nothing may change until the user approves the plan.
  if (tool.name === EXIT_PLAN_MODE_TOOL) {
    return planMode ? { decision: 'ask', reason: 'the user must approve the plan' } : { decision: 'allow', reason: 'plan mode is not active' };
  }
  if (planMode && (tool.class === 'write' || tool.class === 'exec')) {
    return { decision: 'deny', reason: `plan mode is active: ${tool.name} is unavailable until the user approves a plan via ${EXIT_PLAN_MODE_TOOL}` };
  }

  // 3. Bypass.
  if (mode === 'bypass') return { decision: 'allow', reason: 'bypass mode' };

  // 4. Persisted allow rules.
  if (allowedByRules(request, resolved)) return { decision: 'allow', reason: 'matches a saved allow rule' };

  const allConfined = resolved.every((entry) => entry.confined);
  switch (tool.class) {
    case 'read':
    case 'meta':
      return allConfined ? { decision: 'allow', reason: `${tool.class} tool` } : { decision: 'ask', reason: 'path is outside the workspace' };
    case 'write':
      if (mode === 'auto' && allConfined) return { decision: 'allow', reason: 'write confined to the workspace' };
      return { decision: 'ask', reason: allConfined ? 'file changes need approval' : 'path is outside the workspace' };
    case 'exec':
      if (mode === 'auto' && command?.tier === 'safe') return { decision: 'allow', reason: command.reason };
      return { decision: 'ask', reason: command?.reason ?? 'commands need approval' };
    case 'network':
      return { decision: 'ask', reason: 'network access needs approval' };
  }
}

export function decidePermission(request: PermissionRequest): PermissionDecision {
  const verdict = decide(request);
  if (verdict.decision === 'ask' && !request.hasApprover) {
    return { decision: 'deny', reason: `${verdict.reason}; no approver is attached to this session, so it cannot be approved` };
  }
  return verdict;
}

/** Tools the model is even shown. Plan mode hides what it would refuse. */
export function visibleTools(tools: readonly ToolDefinition[], planMode: boolean): ToolDefinition[] {
  return tools.filter((tool) => planMode ? tool.class !== 'write' && tool.class !== 'exec' : tool.name !== EXIT_PLAN_MODE_TOOL);
}

// ── approval text ────────────────────────────────────────────────────────────

export interface ApprovalPrompt { title: string; detail: string }

/** What the human approves must be exactly what runs: the FULL command is
 * never shortened, and a file change shows its path plus a diff preview. */
export async function buildApprovalPrompt(
  tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext, reason: string,
): Promise<ApprovalPrompt> {
  if (tool.name === BASH_TOOL) {
    const lines = [String(args.command ?? ''), '', `cwd: ${ctx.cwd}`];
    if (args.run_in_background === true) lines.push('runs in the background');
    lines.push(`why: ${reason}`);
    return { title: 'Approve command', detail: lines.join('\n') };
  }
  if (tool.name === EXIT_PLAN_MODE_TOOL) return { title: 'Approve plan', detail: String(args.plan ?? '') };
  const paths = tool.paths?.(args) ?? [];
  let preview: string | undefined;
  try { preview = await tool.preview?.(args, ctx); } catch (error) { preview = `(preview unavailable: ${error instanceof Error ? error.message : String(error)})`; }
  if (tool.class === 'write') {
    const shown = paths.map((entry) => path.resolve(ctx.cwd, entry)).join(', ') || tool.label(args);
    const body = preview && preview.length > OUTPUT_CAPS.approvalDetailChars ? `${preview.slice(0, OUTPUT_CAPS.approvalDetailChars)}\n… preview truncated` : preview;
    return { title: `Approve ${tool.label(args)}`, detail: [shown, ...(body ? ['', body] : []), '', `why: ${reason}`].join('\n') };
  }
  if (tool.class === 'network') return { title: 'Approve network request', detail: `${String(args.url ?? tool.label(args))}\nwhy: ${reason}` };
  return { title: `Approve ${tool.label(args)}`, detail: [...paths.map((entry) => path.resolve(ctx.cwd, entry)), ...(preview ? [preview] : []), `why: ${reason}`].join('\n') };
}

// ── persisted rules ──────────────────────────────────────────────────────────

export function permissionSettingsPath(cwd: string): string {
  return path.join(cwd, '.clikcode', 'settings.local.json');
}

export async function loadPermissionRules(cwd: string): Promise<PermissionRules> {
  try {
    const parsed = JSON.parse(await fs.readFile(permissionSettingsPath(cwd), 'utf8')) as { permissions?: { allow?: unknown } };
    return parsePermissionRules(parsed?.permissions?.allow);
  } catch { return NO_RULES; }
}

/** Adds one allow rule, preserving every other key in the file. */
export async function addPermissionAllowRule(cwd: string, rule: string): Promise<PermissionRules> {
  if (!parsePermissionRule(rule)) throw new Error(`Not a valid permission rule: ${rule}`);
  const file = permissionSettingsPath(cwd);
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const permissions = (settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((value): value is string => typeof value === 'string') : [];
  if (!allow.includes(rule.trim())) allow.push(rule.trim());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ ...settings, permissions: { ...permissions, allow } }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
  return parsePermissionRules(allow);
}

/** The narrowest rule that would have allowed this call, for "always allow". */
export function suggestPermissionRule(tool: ToolDefinition, args: Record<string, unknown>, scope: PathScope): string | undefined {
  if (tool.name === BASH_TOOL) {
    const words = String(args.command ?? '').trim().split(/\s+/);
    if (!words[0] || UNSPLITTABLE.test(String(args.command)) || /&&|\|\||;|\|/.test(String(args.command))) return undefined;
    return `Bash(${words.slice(0, Math.min(2, words.length)).join(' ')}:*)`;
  }
  if (tool.class === 'network') { const host = hostOf(args.url); return host ? `WebFetch(domain:${host})` : undefined; }
  if (tool.class === 'write') {
    const first = tool.paths?.(args)[0];
    if (!first) return undefined;
    const resolved = resolvePath(first, scope);
    return resolved.root ? `Edit(${path.relative(resolved.root, resolved.real).split(path.sep).join('/')})` : undefined;
  }
  return undefined;
}
