/** Skills: directories holding a SKILL.md (YAML frontmatter + instructions)
 * that the model loads on demand through the `skill` tool. Only the name and
 * a one-line description of each reach the system prompt; the body costs
 * tokens only when the model decides it needs it.
 *
 * Precedence, first wins on a name clash:
 *   1. <dir>/.clikcode/skills   for cwd and each ancestor up to the repo root (nearest first)
 *   2. <dir>/.claude/skills     same walk
 *   3. <stateDir>/skills
 *   4. ~/.claude/skills
 *   5. each enabled plugin's skills (plugins.ts)
 * A project skill encodes facts about this repository that a personal skill
 * cannot know, so project beats user -- the same "more specific wins" rule
 * as the AGENTS.md chain. Within one scope ClikCode's own directory beats
 * the Claude-compatible one: a same-named ClikCode skill was written for
 * this loop on purpose. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { enabledPluginSkillDirs } from './plugins.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILL_TOOL = 'skill';
/** Caps on the prompt section: small local models pay for every token. The
 * lean profile's; a context profile may pass its own (context-profile.ts). */
export const MAX_LISTED_SKILLS = 20;
export const MAX_DESCRIPTION_CHARS = 150;
/** Per location. A skills directory with thousands of entries is not a skills directory. */
const MAX_SKILL_DIRS = 200;
/** Frontmatter sits at the top; discovery never reads the body. */
const FRONTMATTER_READ_BYTES = 16 * 1024;
const MAX_NAME_CHARS = 64;
const CACHE_ENTRIES = 16;

export type SkillSource = 'project' | 'project-claude' | 'user' | 'user-claude' | 'plugin';

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the skill's directory. */
  dir: string;
  file: string;
  source: SkillSource;
  /** A plugin's skill: its root, for `${CLAUDE_PLUGIN_ROOT}` in the body. */
  pluginRoot?: string;
}

export interface SkippedSkill { file: string; reason: string }

export interface SkillCatalog {
  skills: Skill[];
  skipped: SkippedSkill[];
  /** Same name found in a lower-precedence location. */
  shadowed: Skill[];
}

export interface SkillRoots {
  cwd: string;
  stateDir: string;
  homeDir: string;
}

// ── frontmatter ──────────────────────────────────────────────────────────────

type ParsedFrontmatter = { fields: Record<string, unknown>; body: string } | { error: string };

/** Line-based `key: value` reading of top-level scalars. Real SKILL.md files
 * often carry an unquoted colon in the description ("Use when: ..."), which
 * strict YAML rejects; this is the fallback that still gets name and
 * description out of them. */
function looseFields(block: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    if (value) fields[match[1]] = value;
  }
  return fields;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const source = text.replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { error: 'no YAML frontmatter (the file must start with a --- block)' };
  const body = source.slice(match[0].length);
  try {
    const value: unknown = parseYaml(match[1]);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { fields: value as Record<string, unknown>, body };
    return { error: 'frontmatter is not a key/value mapping' };
  } catch (error) {
    const fields = looseFields(match[1]);
    if (typeof fields.description === 'string') return { fields, body };
    return { error: `invalid YAML frontmatter: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}` };
  }
}

/** Why this frontmatter is unusable, or the skill's name and description. */
function validate(fields: Record<string, unknown>, dirName: string): { name: string; description: string } | { reason: string } {
  // Claude-format skills sometimes omit `name`; the directory is its name there too.
  const name = fields.name === undefined ? dirName : fields.name;
  if (typeof name !== 'string' || !name.trim()) return { reason: '`name` must be a non-empty string' };
  if (/\s/.test(name.trim())) return { reason: `name "${name}" contains whitespace` };
  if (name.trim().length > MAX_NAME_CHARS) return { reason: `name is longer than ${MAX_NAME_CHARS} characters` };
  if (typeof fields.description !== 'string' || !fields.description.trim()) return { reason: 'missing `description`: the model could not tell when to use it' };
  // Claude Code's flag for skills only a person may invoke; this loop has no
  // person-side invocation, so listing it would invite exactly what it forbids.
  if (fields['disable-model-invocation'] === true) return { reason: 'disable-model-invocation is set' };
  return { name: name.trim(), description: fields.description.replace(/\s+/g, ' ').trim() };
}

// ── discovery ────────────────────────────────────────────────────────────────

async function readHead(file: string, bytes: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Nearest ancestor holding `.git` (a directory, or a file in a worktree).
 * A filesystem walk, not a `git` spawn: discovery must stay cheap. */
async function findRepoRoot(cwd: string): Promise<string | undefined> {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

async function scanLocation(dir: string, source: SkillSource, skipped: SkippedSkill[], pluginRoot?: string): Promise<Skill[]> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch {
    // fail-open-ok: a missing skills directory is the common case, not an error
    return [];
  }
  const candidates = entries
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_SKILL_DIRS);
  const found = await Promise.all(candidates.map(async (dirName): Promise<Skill | undefined> => {
    const skillDir = path.join(dir, dirName);
    const file = path.join(skillDir, SKILL_FILE);
    let head: string;
    try { head = await readHead(file, FRONTMATTER_READ_BYTES); } catch {
      // fail-open-ok: a directory without SKILL.md is simply not a skill
      return undefined;
    }
    const parsed = parseFrontmatter(head);
    if ('error' in parsed) { skipped.push({ file, reason: parsed.error }); return undefined; }
    const checked = validate(parsed.fields, dirName);
    if ('reason' in checked) { skipped.push({ file, reason: checked.reason }); return undefined; }
    return { ...checked, dir: skillDir, file, source, ...(pluginRoot ? { pluginRoot } : {}) };
  }));
  return found.filter((skill): skill is Skill => !!skill);
}

async function scanAll(roots: SkillRoots): Promise<SkillCatalog> {
  const cwd = path.resolve(roots.cwd);
  const repoRoot = await findRepoRoot(cwd);
  const projectDirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    projectDirs.push(dir);
    if (!repoRoot || dir === repoRoot || path.dirname(dir) === dir) break;
  }
  const locations: { dir: string; source: SkillSource; pluginRoot?: string }[] = [
    ...projectDirs.map((dir) => ({ dir: path.join(dir, '.clikcode', 'skills'), source: 'project' as const })),
    ...projectDirs.map((dir) => ({ dir: path.join(dir, '.claude', 'skills'), source: 'project-claude' as const })),
    { dir: path.join(roots.stateDir, 'skills'), source: 'user' },
    { dir: path.join(roots.homeDir, '.claude', 'skills'), source: 'user-claude' },
    ...enabledPluginSkillDirs({ stateDir: roots.stateDir, home: roots.homeDir }).map((item) => ({ dir: item.dir, source: 'plugin' as const, pluginRoot: item.root })),
  ];
  const skipped: SkippedSkill[] = [];
  // Scanned in parallel, merged in precedence order.
  const scanned = await Promise.all(locations.map((location) => scanLocation(location.dir, location.source, skipped, location.pluginRoot)));
  const seenDirs = new Set<string>();
  const byName = new Map<string, Skill>();
  const shadowed: Skill[] = [];
  for (const skill of scanned.flat()) {
    // cwd == home makes the project and user .claude/skills the same place.
    const real = await fs.realpath(skill.dir).catch(() => skill.dir);
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    if (byName.has(skill.name)) shadowed.push(skill);
    else byName.set(skill.name, skill);
  }
  return { skills: [...byName.values()], skipped, shadowed };
}

const cache = new Map<string, Promise<SkillCatalog>>();

/** One scan per turn: the system prompt and every `skill` call in the turn
 * share it, and a skill added mid-session appears on the next turn. */
export function discoverSkills(roots: SkillRoots & { turnId?: string }): Promise<SkillCatalog> {
  if (!roots.turnId) return scanAll(roots);
  const key = [roots.turnId, path.resolve(roots.cwd), roots.stateDir, roots.homeDir].join('\0');
  let pending = cache.get(key);
  if (!pending) {
    pending = scanAll(roots);
    cache.set(key, pending);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return pending;
}

// ── prompt section ───────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** Empty string when there are no skills: no section at all, not an empty one. */
export function skillsPromptSection(
  skills: readonly Skill[],
  limits: { maxListedSkills: number; skillDescriptionChars: number } = { maxListedSkills: MAX_LISTED_SKILLS, skillDescriptionChars: MAX_DESCRIPTION_CHARS },
): string {
  if (!skills.length) return '';
  const listed = skills.slice(0, limits.maxListedSkills);
  const more = skills.length - listed.length;
  return [
    '# Skills',
    `Skills are instructions for specific kinds of task. When one fits the task, call ${SKILL_TOOL} with its name before starting and follow what it says.`,
    ...listed.map((skill) => `- ${skill.name}: ${clip(skill.description, limits.skillDescriptionChars)}`),
    ...(more > 0 ? [`(${more} more not listed; ${SKILL_TOOL} with an unknown name lists them all.)`] : []),
  ].join('\n');
}
