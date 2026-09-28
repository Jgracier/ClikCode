/** Token budget and prompt-prefix stability of the agent loop, measured on a
 * recorded 20-step coding session run through the real loop with a scripted
 * model.
 *
 * Tokens are chars/4 (the loop's own estimator), over the request as a
 * llama.cpp chat template lays it out: system, then tool schemas, then the
 * messages. What matters for cost and time is not the size of a request but
 * how much of it differs from the previous one: a provider's prompt cache and
 * llama.cpp's KV-cache reuse both skip only the byte-identical PREFIX.
 *
 * Set TOKEN_REPORT=<file> to write the measured table there. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toChatMessages } from './models/openai-client.js';
import type { ModelStepRequest } from './model-client.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { disposeSessionState } from './session-state.js';
import { ScriptedModelClient, type ScriptedStep } from './testing.js';
import { CONTEXT_PROFILE_ENV, type ContextHints, type ContextProfileName } from './context-profile.js';
import { defineTool, type ToolDefinition } from './tool-contract.js';

let root: string;
let cwd: string;
let stateDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'token-budget-')));
  cwd = path.join(root, 'repo');
  stateDir = path.join(root, 'state');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const pager = Array.from({ length: 120 }, (_, i) => i === 40
    ? '  return items.slice(page * size, page * size + size - 1);'
    : `  // pager line ${i}: ${'x'.repeat(40)}`).join('\n');
  await fs.writeFile(path.join(cwd, 'src', 'pager.ts'), `export function paginate(items, page, size) {\n${pager}\n}\n`);
  await fs.writeFile(path.join(cwd, 'src', 'pager.test.ts'), Array.from({ length: 60 }, (_, i) => `test('case ${i}', () => expect(paginate([], ${i}, 10)).toEqual([]));`).join('\n'));
  await fs.writeFile(path.join(cwd, 'src', 'big.ts'), Array.from({ length: 1500 }, (_, i) => `export const value${i} = ${'"'}${'y'.repeat(30)}${'"'}; // helper`).join('\n'));
  await fs.writeFile(path.join(cwd, 'src', 'helper.ts'), Array.from({ length: 80 }, (_, i) => `export function helper${i}() { return ${i}; }`).join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Stand-ins for the MCP tools measured on the developer's machine (2 servers
 * answering, 76 tools, about 7,900 tokens of schema). Synthetic text: only
 * the size and shape matter here. */
export function syntheticMcpTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const make = (server: string, index: number): ToolDefinition => defineTool({
    name: `mcp__${server}__tool_${String(index).padStart(2, '0')}`,
    description: `Does operation ${index} on the ${server} workspace: describes what it does. (from MCP server "${server}")`,
    parameters: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string', description: 'Identifier of the object to act on, as returned by the list tools.' },
        filters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed', 'all'] }, owner: { type: 'string' } } },
      },
    },
    class: 'exec',
    mcp: { server, tool: `tool_${String(index).padStart(2, '0')}` },
    label: () => `${server} tool ${index}`,
    run: async () => ({ output: `result of ${server} tool ${index}` }),
  });
  for (let i = 0; i < 74; i++) tools.push(make('brain', i));
  for (let i = 0; i < 2; i++) tools.push(make('docs', i));
  return tools;
}

const call = (name: string, args: Record<string, unknown>): NonNullable<ScriptedStep['toolCalls']>[number] => ({ name, args });

/** 20 model steps over two user turns: the shape of a small bug fix. */
const TURN_ONE: ScriptedStep[] = [
  { text: 'Looking for the pager.', toolCalls: [call('grep', { pattern: 'paginate', path: 'src' })] },
  { toolCalls: [call('read_file', { path: 'src/pager.ts' })] },
  { toolCalls: [call('read_file', { path: 'src/pager.test.ts' }), call('list_dir', { path: 'src' })] },
  { toolCalls: [call('todo_write', { todos: [{ content: 'Fix off-by-one', status: 'in_progress' }, { content: 'Add test', status: 'pending' }] })] },
  { toolCalls: [call('edit_file', { path: 'src/pager.ts', old_string: 'page * size + size - 1)', new_string: 'page * size + size)' })] },
  { toolCalls: [call('bash', { command: 'git status --short', description: 'Show changes' })] },
  { toolCalls: [call('read_file', { path: 'src/big.ts' })] },
  { toolCalls: [call('edit_file', { path: 'src/pager.test.ts', old_string: "test('case 0'", new_string: "test('last item is included', () => expect(paginate([1, 2], 0, 2)).toEqual([1, 2]));\ntest('case 0'" })] },
  { toolCalls: [call('bash', { command: 'git diff --stat', description: 'Summarize diff' })] },
  { toolCalls: [call('todo_write', { todos: [{ content: 'Fix off-by-one', status: 'completed' }, { content: 'Add test', status: 'completed' }] })] },
  { text: 'Fixed the off-by-one in src/pager.ts:42 and added a test.' },
];
const TURN_TWO: ScriptedStep[] = [
  { toolCalls: [call('grep', { pattern: 'helper1\\b', path: 'src' })] },
  { toolCalls: [call('read_file', { path: 'src/helper.ts' })] },
  { toolCalls: [call('multi_edit', { path: 'src/helper.ts', edits: [{ old_string: 'helper1()', new_string: 'helperOne()' }, { old_string: 'helper2()', new_string: 'helperTwo()' }] })] },
  { toolCalls: [call('bash', { command: 'git diff --stat', description: 'Summarize diff' })] },
  { toolCalls: [call('glob', { pattern: 'src/**/*.ts' })] },
  { toolCalls: [call('read_file', { path: 'src/helper.ts', offset: 1, limit: 5 })] },
  { toolCalls: [call('edit_file', { path: 'src/helper.ts', old_string: 'helper3()', new_string: 'helperThree()' })] },
  { toolCalls: [call('bash', { command: 'ls src', description: 'List sources' })] },
  { text: 'Renamed the helpers.' },
];

/** The request as text, in the order a llama.cpp chat template renders it. */
export function renderRequest(request: ModelStepRequest): { system: string; tools: string; messages: string; all: string } {
  const [system, ...messages] = toChatMessages(request.system, request.items, false);
  const tools = JSON.stringify(request.tools.map((tool) => ({ type: 'function', function: tool })));
  const parts = { system: JSON.stringify(system), tools, messages: messages.map((message) => JSON.stringify(message)).join('') };
  return { ...parts, all: parts.system + parts.tools + parts.messages };
}

const tokens = (text: string): number => Math.ceil(text.length / 4);

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

interface SessionMeasure {
  steps: number;
  firstStep: { total: number; system: number; tools: number };
  laterStepAvg: number;
  sessionTotal: number;
  /** Tokens a prefix cache could NOT reuse, summed over the session. */
  sessionUncached: number;
  /** Per step: tokens identical to the previous request's prefix. */
  reusedPrefix: number[];
  /** Per step: the previous request's size (its whole text should be reused). */
  previousSize: number[];
}

function measure(requests: readonly ModelStepRequest[]): SessionMeasure {
  const rendered = requests.map(renderRequest);
  const reusedPrefix: number[] = [];
  const previousSize: number[] = [];
  let uncached = tokens(rendered[0].all);
  for (let i = 1; i < rendered.length; i++) {
    const shared = commonPrefix(rendered[i - 1].all, rendered[i].all);
    reusedPrefix.push(tokens(rendered[i - 1].all.slice(0, shared)));
    previousSize.push(tokens(rendered[i - 1].all));
    uncached += tokens(rendered[i].all) - tokens(rendered[i - 1].all.slice(0, shared));
  }
  const totals = rendered.map((entry) => tokens(entry.all));
  return {
    steps: rendered.length,
    firstStep: { total: totals[0], system: tokens(rendered[0].system), tools: tokens(rendered[0].tools) },
    laterStepAvg: Math.round(totals.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, totals.length - 1)),
    sessionTotal: totals.reduce((a, b) => a + b, 0),
    sessionUncached: uncached,
    reusedPrefix, previousSize,
  };
}

/** Project skills with realistic, long descriptions, so the profiles' skill
 * limits show in the numbers. */
async function writeSkills(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const dir = path.join(cwd, '.clikcode', 'skills', `skill-${String(i).padStart(2, '0')}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: skill-${i}\ndescription: Use when the task involves area ${i} of the project -- ${'building, testing and releasing the component, including its configuration files, deployment scripts and the checks that guard them '.repeat(2)}\n---\nBody ${i}.\n`);
  }
}

interface SessionOptions {
  extraTools?: ToolDefinition[];
  contextWindow?: number;
  sessionId: string;
  profile?: ContextProfileName;
  /** What the model client says about its model (context-profile.ts). */
  hints?: ContextHints;
  /** Project skills to create before the session (writeSkills). */
  skills?: number;
  onUsage?: (usage: Record<string, unknown>) => void;
}

async function runSession(options: SessionOptions): Promise<ModelStepRequest[]> {
  // Usage as a server would report it, so the loop's compaction trigger sees
  // the real size of what it sends.
  const client = new ScriptedModelClient([...TURN_ONE, ...TURN_TWO].map((step) => (request: ModelStepRequest) => ({
    ...step, usage: { input: tokens(renderRequest(request).all), output: 50 },
  })));
  if (options.hints) Object.assign(client, { contextHints: options.hints });
  await fs.rm(path.join(cwd, '.clikcode'), { recursive: true, force: true });
  if (options.skills) await writeSkills(options.skills);
  // Each session starts from the committed files: an earlier session in the
  // same test has already applied its edits.
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd, stdio: 'ignore' });
  const base = {
    sessionId: options.sessionId, cwd, stateDir, homeDir: path.join(root, 'home'), userConfigDir: path.join(root, 'config'),
    permissionMode: 'bypass' as const, modelClient: client,
    ...(options.extraTools ? { extraTools: options.extraTools } : {}),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    ...(options.profile ? { contextProfile: options.profile } : {}),
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
  };
  try {
    const first = await runGatewayHarnessTurn({ ...base, prompt: 'Fix the off-by-one in paginate and add a test.' });
    expect(first.stopReason).toBe('completed');
    const second = await runGatewayHarnessTurn({ ...base, prompt: 'Also rename helper1..3 to words.' });
    expect(second.stopReason).toBe('completed');
    // The profile is recorded on the result, and a session keeps one.
    expect(second.contextProfile).toBe(first.contextProfile);
    if (options.profile && !process.env[CONTEXT_PROFILE_ENV]) expect(first.contextProfile).toBe(options.profile);
  } finally {
    disposeSessionState(stateDir, options.sessionId);
  }
  expect(client.requests).toHaveLength(20);
  return client.requests;
}

describe('token budget of a 20-step coding session', () => {
  it('reuses the whole previous request as the prefix of the next, across steps AND turns', async () => {
    const requests = await runSession({ sessionId: 'prefix' });
    const result = measure(requests);
    // Every step after the first starts with the complete previous request:
    // nothing volatile (date, git status, per-step text) sits early in it.
    result.reusedPrefix.forEach((reused, index) => {
      expect({ step: index + 2, reused }).toEqual({ step: index + 2, reused: result.previousSize[index] });
    });
  });

  it('keeps large MCP tool sets out of the prompt until the model asks for them', async () => {
    const withMcp = measure(await runSession({ sessionId: 'mcp', extraTools: syntheticMcpTools() }));
    const without = measure(await runSession({ sessionId: 'plain' }));
    // A listing of the servers costs a little; their schemas do not ride along.
    expect(withMcp.firstStep.tools - without.firstStep.tools).toBeLessThan(1_200);
  });

  it('writes the measured table when TOKEN_REPORT is set', async () => {
    const report = process.env.TOKEN_REPORT;
    if (!report) return;
    const rows: string[] = [];
    const scenarios: [string, Omit<SessionOptions, 'sessionId'>][] = [
      ['builtin tools only', {}],
      ['with 76 MCP tools', { extraTools: syntheticMcpTools() }],
      ['with 76 MCP tools, 32k window', { extraTools: syntheticMcpTools(), contextWindow: 32_768 }],
    ];
    for (const profile of ['minimal', 'lean', 'full'] as const) {
      scenarios.push([`${profile}: builtin tools only`, { profile }]);
      scenarios.push([`${profile}: 76 MCP tools, 30 skills`, { profile, extraTools: syntheticMcpTools(), skills: 30 }]);
    }
    for (const [label, options] of scenarios) {
      const result = measure(await runSession({ sessionId: `report-${rows.length}`, ...options }));
      const stable = result.reusedPrefix.filter((reused, index) => reused === result.previousSize[index]).length;
      rows.push(`| ${label} | ${result.firstStep.total} (sys ${result.firstStep.system}, tools ${result.firstStep.tools}) | ${result.laterStepAvg} | ${result.sessionTotal} | ${result.sessionUncached} | ${stable}/${result.steps - 1} |`);
      rows.push(`|   prefix reuse per step | ${result.reusedPrefix.map((reused, index) => `${reused}/${result.previousSize[index]}`).join(' ')} |`);
    }
    await fs.writeFile(report, ['| session | first step | later step avg | 20-step total | 20-step uncached | steps reusing full prefix |', ...rows].join('\n'));
  });
});

describe('context profiles', () => {
  const heavy = (profile: ContextProfileName): SessionOptions => ({ sessionId: `heavy-${profile}`, profile, extraTools: syntheticMcpTools(), skills: 30 });

  it('reuses the whole previous request as the prefix in every profile', async () => {
    for (const profile of ['minimal', 'lean', 'full'] as const) {
      const result = measure(await runSession(heavy(profile)));
      result.reusedPrefix.forEach((reused, index) => {
        expect({ profile, step: index + 2, reused }).toEqual({ profile, step: index + 2, reused: result.previousSize[index] });
      });
    }
  });

  it('lean is exactly the behavior before profiles: the same requests as a session with no profile', async () => {
    const plain = (await runSession({ sessionId: 'unprofiled', extraTools: syntheticMcpTools(), skills: 30 })).map((request) => renderRequest(request).all);
    const lean = (await runSession(heavy('lean'))).map((request) => renderRequest(request).all);
    expect(lean).toEqual(plain);
  });

  it('spends the least in minimal and the most in full, where each is meant to', async () => {
    const minimal = measure(await runSession(heavy('minimal')));
    const lean = measure(await runSession(heavy('lean')));
    const full = measure(await runSession(heavy('full')));
    // Measured: minimal 3,078 / lean 4,098 / full 13,807 first-step tokens.
    expect(minimal.firstStep.total).toBeLessThan(lean.firstStep.total - 900);
    // Minimal: no tool-usage sections, shorter and fewer skills...
    expect(lean.firstStep.system - minimal.firstStep.system).toBeGreaterThan(700);
    // ...and schemas without additionalProperties:false, terser rare tools.
    expect(lean.firstStep.tools - minimal.firstStep.tools).toBeGreaterThan(200);
    // Full: the 76 MCP schemas (~7,900 tokens) go up front instead of the loader...
    expect(full.firstStep.tools - lean.firstStep.tools).toBeGreaterThan(7_000);
    // ...and more of the 30 skills are listed, at more length.
    expect(full.firstStep.system - lean.firstStep.system).toBeGreaterThan(1_000);
  });

  it('gives full a larger tool-output cap, still bounded by the window', async () => {
    const bigRead = (requests: ModelStepRequest[]): number => {
      const item = requests.at(-1)!.items.find((entry) => entry.type === 'tool_result' && entry.name === 'read_file' && entry.output.includes('value0 '));
      return item?.type === 'tool_result' ? item.output.length : 0;
    };
    const lean = bigRead(await runSession({ sessionId: 'out-lean', profile: 'lean' }));
    const full = bigRead(await runSession({ sessionId: 'out-full', profile: 'full' }));
    const fullSmall = bigRead(await runSession({ sessionId: 'out-full-32k', profile: 'full', contextWindow: 32_768 }));
    expect(lean).toBeLessThanOrEqual(30 * 1024);
    // 10% of the default 128K window, ~4 bytes a token: ~51 KB.
    expect(full).toBeGreaterThan(45 * 1024);
    expect(full).toBeLessThanOrEqual(52 * 1024);
    expect(fullSmall).toBeLessThanOrEqual(13 * 1024);
  });

  it('chooses the profile from what the model client reports', async () => {
    const seen: unknown[] = [];
    const onUsage = (usage: Record<string, unknown>): void => { seen.push(usage.contextProfile); };
    const hosted = measure(await runSession({ sessionId: 'auto-hosted', hints: { hosted: true, contextWindow: 200_000 }, extraTools: syntheticMcpTools(), onUsage }));
    expect(new Set(seen)).toEqual(new Set(['full']));
    seen.length = 0;
    const cpu = measure(await runSession({ sessionId: 'auto-cpu', hints: { contextWindow: 32_768, promptPerSecond: 70 }, extraTools: syntheticMcpTools(), onUsage }));
    expect(new Set(seen)).toEqual(new Set(['minimal']));
    expect(hosted.firstStep.tools - cpu.firstStep.tools).toBeGreaterThan(7_000);
  });

  it(`lets ${CONTEXT_PROFILE_ENV} force a profile over the session's own`, async () => {
    const previous = process.env[CONTEXT_PROFILE_ENV];
    process.env[CONTEXT_PROFILE_ENV] = 'minimal';
    try {
      const seen: unknown[] = [];
      const requests = await runSession({ sessionId: 'forced', profile: 'full', hints: { hosted: true }, onUsage: (usage) => { seen.push(usage.contextProfile); } });
      expect(new Set(seen)).toEqual(new Set(['minimal']));
      expect(JSON.stringify(requests[0].tools)).not.toContain('additionalProperties');
      expect(requests[0].system).not.toContain('# Editing files');
    } finally {
      if (previous === undefined) delete process.env[CONTEXT_PROFILE_ENV];
      else process.env[CONTEXT_PROFILE_ENV] = previous;
    }
  });
});
