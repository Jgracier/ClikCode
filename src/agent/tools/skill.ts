import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverSkills, parseFrontmatter, SKILL_FILE, SKILL_TOOL, type Skill } from '../skills.js';
import { defineTool } from '../tool-contract.js';
import { looksBinary } from './fs-helpers.js';

interface SkillArgs { name: string; file?: string }

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 100;
const MAX_WALK_DEPTH = 4;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__']);

/** Supporting files, relative to the skill directory. Bounded in count and
 * depth: a skill that vendors a whole project must not flood the context. */
async function listSupportingFiles(skillDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      const relative = path.relative(skillDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        if (depth < MAX_WALK_DEPTH) await walk(full, depth + 1);
        else truncated = true;
      } else if (relative !== SKILL_FILE) files.push(relative);
    }
  };
  await walk(skillDir, 1);
  return { files, truncated };
}

/** A file inside the skill directory, or why not. Checked on real paths so a
 * symlink cannot lead out of the skill. */
async function resolveSkillFile(skill: Skill, file: string): Promise<{ real: string } | { error: string }> {
  let base: string;
  let real: string;
  try {
    base = await fs.realpath(skill.dir);
    real = await fs.realpath(path.resolve(skill.dir, file));
  } catch {
    return { error: `No file "${file}" in skill ${skill.name}.` };
  }
  const relative = path.relative(base, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { error: `"${file}" is not inside skill ${skill.name}.` };
  return { real };
}

/** Reads a skill (or one of its files) from wherever it was discovered. It
 * reads these itself rather than sending the model to read_file because user
 * skills live in the private state directory and in ~/.claude, where
 * read_file is refused or needs approval. Only discovered skill directories
 * are reachable, so no `paths` are declared. */
export const skillTool = defineTool<SkillArgs>({
  name: SKILL_TOOL,
  class: 'read',
  description: 'Load a skill listed under Skills in the system prompt: returns its instructions and its supporting files. Pass file (a path from that list) to read one of them.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['name'],
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      file: { type: 'string', description: 'A supporting file of the skill, relative to the skill directory.' },
    },
  },
  label: (args) => (args.file ? `Skill ${args.name}: ${args.file}` : `Skill ${args.name}`),
  async run(args, ctx) {
    const catalog = await discoverSkills({ cwd: ctx.cwd, stateDir: ctx.stateDir, homeDir: ctx.homeDir, turnId: ctx.turnId });
    const skill = catalog.skills.find((entry) => entry.name === args.name);
    if (!skill) {
      const names = catalog.skills.map((entry) => entry.name);
      return { output: names.length ? `No skill named "${args.name}". Available: ${names.join(', ')}.` : 'No skills are installed.', isError: true };
    }
    const target = args.file ? await resolveSkillFile(skill, args.file) : { real: skill.file };
    if ('error' in target) return { output: target.error, isError: true };
    let buffer: Buffer;
    try {
      const stat = await fs.stat(target.real);
      if (stat.isDirectory()) return { output: `"${args.file}" is a directory; pass one of the listed files.`, isError: true };
      if (stat.size > MAX_SKILL_BYTES) return { output: `${args.file ?? SKILL_FILE} is ${stat.size} bytes, too large to load.`, isError: true };
      buffer = await fs.readFile(target.real);
    } catch (error) {
      return { output: `Cannot read ${args.file ?? SKILL_FILE} of skill ${skill.name}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, isError: true };
    }
    if (looksBinary(buffer)) return { output: `${args.file} is a binary file (${buffer.length} bytes); not shown.` };
    const text = buffer.toString('utf8');
    if (args.file) return { output: text || `${args.file} is empty.` };

    const parsed = parseFrontmatter(text);
    const body = ('body' in parsed ? parsed.body : text).trim();
    const { files, truncated } = await listSupportingFiles(skill.dir);
    return {
      output: [
        `Skill: ${skill.name} (${skill.dir})`,
        '',
        body || '(SKILL.md has no instructions beyond its description.)',
        ...(files.length ? [
          '',
          `Supporting files (read with ${SKILL_TOOL} name="${skill.name}" file="<path>"):`,
          ...files.map((file) => `- ${file}`),
          ...(truncated ? ['- … more not listed'] : []),
        ] : []),
      ].join('\n'),
    };
  },
});
