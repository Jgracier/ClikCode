/** User-defined slash commands: `*.md` prompt templates.
 *
 * Discovered in the active harness's catalog `customCommandDirs` plus
 * ClikCode's own `.clikcode/commands` (workspace) and `~/.clikcode/commands`.
 * Optional frontmatter carries `description` and `argument-hint`; the body is
 * the prompt, with `$ARGUMENTS` and `$1`..`$9` expanded client-side whenever
 * the harness cannot run the command natively. No harness names here. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';

export interface CustomCommand {
  /** Slash name without the slash; nested files use `dir:file`. */
  name: string;
  description?: string;
  argumentHint?: string;
  path: string;
  body: string;
  /** `harness`: found in the harness's own command directory, so a harness
   * that declares `nativeSlashPassthrough` can run it itself. */
  source: 'harness' | 'clikcode';
}

interface CustomCommandRoots {
  workspace: string;
  home?: string;
  /** Replaces the ClikCode directories (tests). */
  clikcodeDirs?: readonly string[];
}

const CLIKCODE_DIRS = ['.clikcode/commands', '~/.clikcode/commands'] as const;
const MAX_DEPTH = 3;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_COMMANDS_PER_DIR = 200;

export function parseCustomCommandFile(text: string): { description?: string; argumentHint?: string; body: string } {
  const normalized = text.replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) return { body: normalized.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    meta[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  const description = meta.description;
  const argumentHint = meta['argument-hint'] ?? meta.argument_hint;
  return {
    body: normalized.slice(match[0].length).trim(),
    ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}),
  };
}

/** Shell-like split: whitespace separates, quotes group. */
export function splitCommandArguments(args: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(args); match; match = pattern.exec(args)) {
    result.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] ?? match[3] ?? '');
  }
  return result;
}

/** `$ARGUMENTS` -> the whole argument string, `$1`..`$9` -> positional words.
 * A template that uses neither still receives the arguments, appended. */
export function expandCustomCommand(command: Pick<CustomCommand, 'body'>, args: string): string {
  const trimmed = args.trim();
  const positional = splitCommandArguments(trimmed);
  const usesPlaceholder = /\$ARGUMENTS\b|\$[1-9]\b/.test(command.body);
  // One pass, not one per placeholder: a second .replace() would re-scan text
  // that the first one substituted, so `/cmd '$& $1'` expanded the user's own
  // `$1` as if it were a placeholder in the template. A function replacer
  // keeps `$&` and friends literal within the pass itself.
  const expanded = command.body.replace(/\$ARGUMENTS\b|\$([1-9])\b/g,
    (_, digit?: string) => (digit === undefined ? trimmed : positional[Number(digit) - 1] ?? ''));
  return (usesPlaceholder || !trimmed ? expanded : `${expanded}\n\n${trimmed}`).trim();
}

interface DirectoryCacheEntry { stamp: string; commands: CustomCommand[] }
const directoryCache = new Map<string, DirectoryCacheEntry>();
export function resetCustomCommandCache(): void { directoryCache.clear(); }

function expandRoot(directory: string, roots: Required<Pick<CustomCommandRoots, 'workspace' | 'home'>>): string {
  if (directory === '~') return roots.home;
  if (/^~[\\/]/.test(directory)) return join(roots.home, directory.slice(2));
  return isAbsolute(directory) ? directory : resolve(roots.workspace, directory);
}

/** Directory mtimes (this directory and its subdirectories) are the cache
 * key: adding, removing or renaming a file changes its parent's mtime. File
 * mtimes join the stamp so an in-place edit is picked up as well. */
function scanDirectory(root: string, source: CustomCommand['source']): CustomCommand[] {
  const files: string[] = [];
  const stamps: string[] = [];
  const visit = (directory: string, depth: number): void => {
    let names: string[];
    try {
      stamps.push(`${directory}:${statSync(directory).mtimeMs}`);
      names = readdirSync(directory).sort();
    } catch {
      return; // fail-open-ok: a command directory that does not exist has no commands
    }
    for (const name of names) {
      if (files.length >= MAX_COMMANDS_PER_DIR || name.startsWith('.')) continue;
      const path = join(directory, name);
      let info;
      try { info = statSync(path); } catch { continue; } // fail-open-ok: raced with a delete
      if (info.isDirectory()) { if (depth < MAX_DEPTH) visit(path, depth + 1); continue; }
      if (!info.isFile() || !name.toLowerCase().endsWith('.md') || info.size > MAX_FILE_BYTES) continue;
      files.push(path);
      stamps.push(`${path}:${info.mtimeMs}:${info.size}`);
    }
  };
  visit(root, 0);
  const stamp = stamps.join('|');
  const cached = directoryCache.get(root);
  if (cached && cached.stamp === stamp) return cached.commands;
  const commands: CustomCommand[] = [];
  for (const path of files) {
    const name = relative(root, path).slice(0, -'.md'.length).split(sep).join(':').toLowerCase();
    if (!/^[a-z0-9][\w:.-]*$/.test(name)) continue;
    try {
      commands.push({ name, path, source, ...parseCustomCommandFile(readFileSync(path, 'utf8')) });
    } catch {
      // fail-open-ok: an unreadable template is simply not offered
    }
  }
  directoryCache.set(root, { stamp, commands });
  return commands;
}

/** First definition of a name wins: workspace before home, the harness's own
 * directories before ClikCode's (so a passthrough harness runs ITS command). */
export function discoverCustomCommands(
  harness: Pick<AiLocalHarnessDefinition, 'customCommandDirs'> | undefined, roots: CustomCommandRoots,
): CustomCommand[] {
  const resolvedRoots = { workspace: roots.workspace, home: roots.home ?? homedir() };
  const seen = new Set<string>();
  const result: CustomCommand[] = [];
  const add = (directories: readonly string[], source: CustomCommand['source']): void => {
    for (const directory of directories) {
      for (const command of scanDirectory(expandRoot(directory, resolvedRoots), source)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        result.push(command);
      }
    }
  };
  add(harness?.customCommandDirs ?? [], 'harness');
  add(roots.clikcodeDirs ?? CLIKCODE_DIRS, 'clikcode');
  return result;
}

/** The prompt to send for `/name args`. A harness that runs slash commands
 * itself gets its OWN command verbatim; everything else is expanded here. */
export function customCommandPrompt(
  command: CustomCommand, args: string, harness: Pick<AiLocalHarnessDefinition, 'nativeSlashPassthrough'> | undefined,
): string {
  if (harness?.nativeSlashPassthrough && command.source === 'harness') return `/${command.name}${args.trim() ? ` ${args.trim()}` : ''}`;
  return expandCustomCommand(command, args);
}
