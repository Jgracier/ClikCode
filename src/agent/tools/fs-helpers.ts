/** Shared filesystem plumbing for the file tools. Tools re-check the hard
 * deny lists themselves (defence in depth): the permission layer decides
 * whether to ASK, but a denied location is refused here even if a caller
 * wires a tool up without that layer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { globToRegExp, matchGlob } from '../glob-match.js';
import { readDenyReason, resolvePath, writeDenyReason, type PathScope, type ResolvedPath } from '../security.js';
import type { ToolContext } from '../types.js';

export class ToolInputError extends Error {}

export function scopeOf(ctx: ToolContext): PathScope {
  return { cwd: ctx.cwd, addDirs: ctx.addDirs, stateDir: ctx.stateDir, homeDir: ctx.homeDir };
}

export function resolveForRead(input: string, ctx: ToolContext): ResolvedPath {
  const resolved = resolvePath(input, scopeOf(ctx));
  const denied = readDenyReason(resolved, scopeOf(ctx));
  if (denied) throw new ToolInputError(`Refused: ${denied}`);
  return resolved;
}

export function resolveForWrite(input: string, ctx: ToolContext): ResolvedPath {
  const resolved = resolvePath(input, scopeOf(ctx));
  const denied = writeDenyReason(resolved, scopeOf(ctx));
  if (denied) throw new ToolInputError(`Refused: ${denied}`);
  return resolved;
}

export function displayPath(absolute: string, ctx: Pick<ToolContext, 'cwd'>): string {
  const relative = path.relative(ctx.cwd, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
}

/** NUL bytes, or a high share of control characters, in the first 8 KB. */
export function looksBinary(sample: Uint8Array): boolean {
  const length = Math.min(sample.length, 8192);
  if (!length) return false;
  let suspicious = 0;
  for (let i = 0; i < length; i++) {
    const byte = sample[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) suspicious++;
  }
  return suspicious / length > 0.3;
}

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.heic', '.avif']);
export const ALWAYS_SKIPPED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
}

// ── .gitignore basics ────────────────────────────────────────────────────────

interface IgnoreRule { pattern: string; negated: boolean; dirOnly: boolean; anchored: boolean; base: string }

export function parseGitignore(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (line) rules.push({ pattern: line, negated, dirOnly, anchored, base });
  }
  return rules;
}

/** `relative` is `/`-separated and relative to the walk root. Last match wins. */
export function isIgnored(rules: readonly IgnoreRule[], relative: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.base && !(relative === rule.base || relative.startsWith(`${rule.base}/`))) continue;
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative;
    if (!local) continue;
    // Anchored patterns match the whole path from the .gitignore's directory;
    // matchGlob's basename shortcut would wrongly let `/rooted.txt` hit a
    // nested `a/rooted.txt`.
    const hit = rule.anchored ? globToRegExp(rule.pattern).test(local) : matchGlob(rule.pattern, local.slice(local.lastIndexOf('/') + 1));
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

export interface WalkOptions {
  signal?: AbortSignal;
  honorGitignore?: boolean;
  includeHidden?: boolean;
  maxEntries?: number;
}

export interface WalkedFile { absolute: string; relative: string }

/** Depth-first file walk. Never follows directory symlinks (a link out of the
 * workspace would otherwise defeat confinement), always skips VCS internals
 * and node_modules, and optionally applies nested .gitignore files. */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const maxEntries = options.maxEntries ?? 200_000;
  let seen = 0;
  async function* visit(dir: string, relativeDir: string, inherited: readonly IgnoreRule[]): AsyncGenerator<WalkedFile> {
    throwIfAborted(options.signal);
    let rules = inherited;
    if (options.honorGitignore !== false) {
      try { rules = [...inherited, ...parseGitignore(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), relativeDir)]; } catch { /* none */ }
    }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      if (ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;
      if (!options.includeHidden && entry.name.startsWith('.') && entry.isDirectory()) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isIgnored(rules, relative, true)) continue;
        yield* visit(path.join(dir, entry.name), relative, rules);
      } else if (entry.isFile()) {
        if (isIgnored(rules, relative, false)) continue;
        yield { absolute: path.join(dir, entry.name), relative };
      }
    }
  }
  yield* visit(root, '', []);
}
