import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGatewayHarnessTurn } from './run-turn.js';
import { discoverSkills, MAX_DESCRIPTION_CHARS, MAX_LISTED_SKILLS, parseFrontmatter, skillsPromptSection, type Skill } from './skills.js';
import { ScriptedModelClient } from './testing.js';
import type { ToolContext } from './tool-contract.js';
import { skillTool } from './tools/skill.js';

let root: string;
let repo: string;
let cwd: string;
let stateDir: string;
let homeDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-')));
  repo = path.join(root, 'repo');
  cwd = path.join(repo, 'packages', 'app');
  stateDir = path.join(root, 'state');
  homeDir = path.join(root, 'home');
  await Promise.all([cwd, stateDir, homeDir, path.join(repo, '.git')].map((dir) => fs.mkdir(dir, { recursive: true })));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeSkill(base: string, dirName: string, frontmatter: string, body = 'Do the steps.', extra: Record<string, string> = {}): Promise<string> {
  const dir = path.join(base, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
  for (const [file, text] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
  return dir;
}

const roots = (): { cwd: string; stateDir: string; homeDir: string } => ({ cwd, stateDir, homeDir });

describe('parseFrontmatter', () => {
  it('reads YAML fields and separates the body', () => {
    const parsed = parseFrontmatter('---\nname: a\ndescription: "b: c"\n---\n# Body\n');
    expect(parsed).toEqual({ fields: { name: 'a', description: 'b: c' }, body: '# Body\n' });
  });

  it('falls back to line parsing for unquoted colons strict YAML rejects', () => {
    const parsed = parseFrontmatter('---\nname: deploy\ndescription: Use when: deploying things\n---\nbody');
    expect(parsed).toMatchObject({ fields: { name: 'deploy', description: 'Use when: deploying things' } });
  });

  it('reports a missing frontmatter block', () => {
    expect(parseFrontmatter('# Just markdown')).toEqual({ error: expect.stringContaining('no YAML frontmatter') });
  });
});

describe('discoverSkills', () => {
  it('finds skills in all four locations, nearest project first, and dedups by name with precedence', async () => {
    await writeSkill(path.join(cwd, '.clikcode', 'skills'), 'shared', 'name: shared\ndescription: from cwd clikcode');
    await writeSkill(path.join(repo, '.clikcode', 'skills'), 'shared', 'name: shared\ndescription: from repo clikcode');
    await writeSkill(path.join(repo, '.clikcode', 'skills'), 'repo-only', 'name: repo-only\ndescription: repo');
    await writeSkill(path.join(repo, '.claude', 'skills'), 'claude-proj', 'name: claude-proj\ndescription: project claude');
    await writeSkill(path.join(repo, '.claude', 'skills'), 'userish', 'name: userish\ndescription: project claude wins');
    await writeSkill(path.join(stateDir, 'skills'), 'userish', 'name: userish\ndescription: user clikcode');
    await writeSkill(path.join(stateDir, 'skills'), 'mine', 'name: mine\ndescription: user');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'mine', 'name: mine\ndescription: user claude');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'cc', 'description: no name, directory names it');
    // Above the repo root: not part of this project.
    await writeSkill(path.join(root, '.clikcode', 'skills'), 'outside', 'name: outside\ndescription: nope');

    const catalog = await discoverSkills(roots());
    const byName = Object.fromEntries(catalog.skills.map((skill) => [skill.name, skill]));
    expect(Object.keys(byName).sort()).toEqual(['cc', 'claude-proj', 'mine', 'repo-only', 'shared', 'userish']);
    expect(byName.shared.description).toBe('from cwd clikcode');
    expect(byName.userish).toMatchObject({ description: 'project claude wins', source: 'project-claude' });
    expect(byName.mine).toMatchObject({ description: 'user', source: 'user' });
    expect(byName.cc.source).toBe('user-claude');
    expect(catalog.shadowed.map((skill) => skill.description).sort()).toEqual(['from repo clikcode', 'user claude', 'user clikcode']);
  });

  it('skips malformed skills with a reason and ignores directories without SKILL.md', async () => {
    const base = path.join(repo, '.clikcode', 'skills');
    await writeSkill(base, 'good', 'name: good\ndescription: fine');
    await writeSkill(base, 'no-desc', 'name: no-desc');
    await writeSkill(base, 'spaced', 'name: has space\ndescription: x');
    await writeSkill(base, 'broken', 'name: [unclosed\n  - : :');
    await writeSkill(base, 'hidden-from-model', 'name: hidden-from-model\ndescription: x\ndisable-model-invocation: true');
    await fs.mkdir(path.join(base, 'bare'), { recursive: true });
    await fs.writeFile(path.join(base, 'bare', 'README.md'), 'not a skill');
    await fs.mkdir(path.join(base, 'plain'), { recursive: true });
    await fs.writeFile(path.join(base, 'plain', 'SKILL.md'), '# no frontmatter');

    const catalog = await discoverSkills(roots());
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['good']);
    const reasons = Object.fromEntries(catalog.skipped.map((entry) => [path.basename(path.dirname(entry.file)), entry.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['broken', 'hidden-from-model', 'no-desc', 'plain', 'spaced']);
    expect(reasons['no-desc']).toMatch(/description/);
    expect(reasons.spaced).toMatch(/whitespace/);
    expect(reasons.broken).toMatch(/invalid YAML/);
    expect(reasons.plain).toMatch(/no YAML frontmatter/);
  });

  it('without a repository only looks at cwd itself, and counts one directory once when cwd is home', async () => {
    await fs.rm(path.join(repo, '.git'), { recursive: true });
    await writeSkill(path.join(repo, '.clikcode', 'skills'), 'parent', 'name: parent\ndescription: x');
    expect((await discoverSkills(roots())).skills).toEqual([]);

    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'once', 'name: once\ndescription: x');
    const catalog = await discoverSkills({ cwd: homeDir, stateDir, homeDir });
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['once']);
    expect(catalog.shadowed).toEqual([]);
  });

  it('caches per turn id and rescans for a new turn', async () => {
    const first = await discoverSkills({ ...roots(), turnId: 't1' });
    await writeSkill(path.join(stateDir, 'skills'), 'late', 'name: late\ndescription: x');
    expect(await discoverSkills({ ...roots(), turnId: 't1' })).toBe(first);
    expect((await discoverSkills({ ...roots(), turnId: 't2' })).skills.map((skill) => skill.name)).toEqual(['late']);
  });
});

describe('skillsPromptSection', () => {
  const skill = (name: string, description: string): Skill => ({ name, description, dir: '/x', file: '/x/SKILL.md', source: 'user' });

  it('is empty when there are no skills', () => {
    expect(skillsPromptSection([])).toBe('');
  });

  it('lists name and clipped description, capped in count', () => {
    const long = `${'word '.repeat(80)}end`;
    const skills = Array.from({ length: MAX_LISTED_SKILLS + 3 }, (_, index) => skill(`s${index}`, index === 0 ? long : 'short'));
    const section = skillsPromptSection(skills);
    const lines = section.split('\n');
    expect(lines[0]).toBe('# Skills');
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(MAX_LISTED_SKILLS);
    const first = lines.find((line) => line.startsWith('- s0: '))!;
    expect(first.length).toBeLessThanOrEqual('- s0: '.length + MAX_DESCRIPTION_CHARS);
    expect(first.endsWith('…')).toBe(true);
    expect(section).toContain('- s1: short');
    expect(section).toContain('(3 more not listed;');
  });
});

describe('skill tool', () => {
  const ctx = (turnId: string): ToolContext => ({ cwd, addDirs: [], sessionId: 's', turnId, stateDir, homeDir } as unknown as ToolContext);

  it('returns the body and supporting files, and reads a supporting file on request', async () => {
    // In the state dir, where read_file is refused: the tool must read it itself.
    await writeSkill(path.join(stateDir, 'skills'), 'deploy', 'name: deploy\ndescription: ship it', '# Deploy\nRun the script.', {
      'scripts/run.sh': 'echo hi\n', 'references/api.md': 'API notes', 'node_modules/x/index.js': 'skip me',
    });
    const result = await skillTool.run({ name: 'deploy' }, ctx('a'));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Deploy\nRun the script.');
    expect(result.output).not.toContain('description: ship it');
    expect(result.output).toContain('- references/api.md\n- scripts/run.sh');
    expect(result.output).not.toContain('node_modules');

    expect((await skillTool.run({ name: 'deploy', file: 'references/api.md' }, ctx('a'))).output).toBe('API notes');
  });

  it('refuses files outside the skill directory, including through symlinks', async () => {
    const dir = await writeSkill(path.join(repo, '.clikcode', 'skills'), 'x', 'name: x\ndescription: x');
    await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
    await fs.symlink(path.join(root, 'secret.txt'), path.join(dir, 'link.txt'));
    for (const file of ['../../../../secret.txt', 'link.txt', path.join(root, 'secret.txt')]) {
      const result = await skillTool.run({ name: 'x', file }, ctx('b'));
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain('secret\n');
    }
  });

  it('names the available skills when asked for an unknown one', async () => {
    await writeSkill(path.join(repo, '.clikcode', 'skills'), 'alpha', 'name: alpha\ndescription: x');
    expect(await skillTool.run({ name: 'beta' }, ctx('c'))).toEqual({ output: 'No skill named "beta". Available: alpha.', isError: true });
  });
});

describe('system prompt', () => {
  const systemFor = async (): Promise<string> => {
    const client = new ScriptedModelClient([{ text: 'done' }]);
    await runGatewayHarnessTurn({ sessionId: `p${Math.random()}`, cwd, stateDir, homeDir, userConfigDir: path.join(root, 'config'), prompt: 'hi', permissionMode: 'bypass', modelClient: client });
    return client.requests[0].system;
  };

  it('has no Skills section when no skill exists', async () => {
    expect(await systemFor()).not.toContain('# Skills');
  });

  it('lists discovered skills before the environment block', async () => {
    await writeSkill(path.join(repo, '.clikcode', 'skills'), 'alpha', 'name: alpha\ndescription: Alpha things.');
    const system = await systemFor();
    expect(system).toContain('# Skills');
    expect(system).toContain('- alpha: Alpha things.');
    expect(system.indexOf('# Skills')).toBeLessThan(system.indexOf('# Environment'));
  });
});
