#!/usr/bin/env node
// A small fixed check of the agent on one model: the same tool-calling tasks every time, each graded by what is left on disk,
// so a change to context, caching or a server flag can be judged by whether the agent still does the work.
//
//   node scripts/agent-check.mjs --harness clikcode-local --model <catalog id>
//   node scripts/agent-check.mjs --harness gateway --model <gateway model id> [--only recall,edit]
//
// Runs the built CLI (dist/cli.js) with `send`, in a fresh temp folder per task. Prints one line per task and a summary; exits 1
// if a task failed. Uses the real model, so a Gateway run costs credit and a local run loads the model: it is never part of the
// unit tests.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.AGENT_CHECK_CLI ?? join(root, 'dist', 'cli.js');
const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const harness = flag('harness');
const model = flag('model');
const only = flag('only')?.split(',');
const timeoutMs = Number(flag('timeout') ?? 900) * 1000;
if (!harness) { console.error('usage: agent-check.mjs --harness <clikcode-local|gateway> [--model <id>] [--only a,b] [--timeout seconds]'); process.exit(2); }

// Not the system temp folder: ClikCode may point that at its own private state, which the agent is rightly refused.
const work = process.env.AGENT_CHECK_DIR ?? join(root, '.tmp', 'agent-check');
const read = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

const TASKS = [
  {
    name: 'read',
    prompt: 'The file notes.txt has a line starting with "code:". Tell me the code in your reply.',
    setup: (dir) => writeFileSync(join(dir, 'notes.txt'), 'title: shopping\nitems: 4\ncode: PX-4172\nend\n'),
    check: (_dir, reply) => reply.includes('PX-4172'),
  },
  {
    name: 'edit',
    prompt: 'In greet.js change the greeting from "hello" to "goodbye". Change nothing else.',
    setup: (dir) => writeFileSync(join(dir, 'greet.js'), 'export function greet(name) {\n  return `hello, ${name}`;\n}\n'),
    check: (dir) => read(dir, 'greet.js') === 'export function greet(name) {\n  return `goodbye, ${name}`;\n}\n',
  },
  {
    name: 'create',
    prompt: 'Create sum.js exporting a function sum(list) that returns the sum of an array of numbers.',
    setup: () => {},
    check: (dir) => {
      const file = join(dir, 'sum.js');
      if (!existsSync(file)) return false;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { sum } from ${JSON.stringify(file)}; process.stdout.write(String(sum([1, 2, 3, 4.5])));`], { encoding: 'utf8' });
      return run.stdout === '10.5';
    },
  },
  {
    name: 'shell',
    prompt: 'Run the command `node count.js` and write what it prints, exactly, to result.txt.',
    setup: (dir) => writeFileSync(join(dir, 'count.js'), 'let n = 0;\nfor (let i = 1; i <= 20; i++) n += i * i;\nconsole.log("total=" + n);\n'),
    check: (dir) => read(dir, 'result.txt').trim() === 'total=2870',
  },
  {
    name: 'multi-step',
    prompt: 'The files a.txt, b.txt and c.txt each hold one number. Put the three numbers, added together, in total.txt.',
    setup: (dir) => { writeFileSync(join(dir, 'a.txt'), '17\n'); writeFileSync(join(dir, 'b.txt'), '25\n'); writeFileSync(join(dir, 'c.txt'), '100\n'); },
    check: (dir) => read(dir, 'total.txt').trim() === '142',
  },
  {
    name: 'bug',
    prompt: 'The test in check.js fails. Find the bug in lib.js and fix it so `node check.js` passes. Do not edit check.js.',
    setup: (dir) => {
      writeFileSync(join(dir, 'lib.js'), 'export function average(list) {\n  return list.reduce((a, b) => a + b, 0) / (list.length - 1);\n}\n');
      writeFileSync(join(dir, 'check.js'), 'import { average } from "./lib.js";\nif (average([2, 4, 6]) !== 4) { console.error("average wrong"); process.exit(1); }\nconsole.log("ok");\n');
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    },
    check: (dir) => {
      const run = spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8' });
      return run.status === 0 && read(dir, 'check.js').includes('average([2, 4, 6]) !== 4');
    },
  },
  {
    // The risk of a short search result: the broad term matches far more lines than are shown, and the answer is in a file that sorts last.
    name: 'search',
    prompt: 'Somewhere in this project is the time, in milliseconds, that it waits between retry attempts. Find the value and write just the number to answer.txt.',
    setup: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      for (let i = 0; i < 40; i += 1) {
        writeFileSync(join(dir, 'src', `module-${String(i).padStart(2, '0')}.js`), Array.from({ length: 6 }, (_, line) => `// retry note ${i}.${line}: callers may retry this\nexport const LIMIT_${i}_${line} = ${i * 10 + line};`).join('\n') + '\n');
      }
      writeFileSync(join(dir, 'src', 'zz-network.js'), '// wait between retry attempts, in milliseconds\nexport const BACKOFF_MS = 7310;\n');
    },
    check: (dir) => read(dir, 'answer.txt').trim() === '7310',
  },
  {
    // More reading than a small window holds, one fact per file: a model that writes each down as it goes passes; one that means to
    // collect them at the end needs the early files still in view.
    name: 'long',
    prompt: 'The folder docs has 20 files, doc-01.txt to doc-20.txt. Each has one line "key: <word>". Read each file with read_file (no grep, cat or other shell shortcuts, no scripts), then write the 20 words, one per line in file order, to keys.txt.',
    setup: (dir) => {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      const words = Array.from({ length: 20 }, (_, i) => `w${String(i + 1).padStart(2, '0')}${['fox', 'owl', 'elk', 'ram'][i % 4]}`);
      writeFileSync(join(dir, 'words.json'), JSON.stringify(words));
      words.forEach((word, i) => writeFileSync(join(dir, 'docs', `doc-${String(i + 1).padStart(2, '0')}.txt`),
        `${Array.from({ length: 30 }, (_, line) => `background paragraph ${i + 1}.${line}: ${'lorem ipsum dolor sit amet '.repeat(5)}`).join('\n')}\nkey: ${word}\n`));
    },
    check: (dir) => {
      const expected = JSON.parse(read(dir, 'words.json'));
      const got = read(dir, 'keys.txt').split('\n').map((line) => line.trim()).filter(Boolean);
      return got.length === expected.length && expected.every((word, i) => got[i] === word);
    },
  },
  {
    // The risk of a shortened view: a fact given early, then a long run of work, then a question that needs the early fact.
    name: 'recall',
    prompt: 'Remember this for later: the release codename is "heron-9". Now do this: read each of the twelve files part-1.txt .. part-12.txt, '
      + 'and append one line to log.txt for each file saying how many lines it has. Finally write the release codename I gave you at the start to codename.txt.',
    setup: (dir) => {
      for (let i = 1; i <= 12; i += 1) writeFileSync(join(dir, `part-${i}.txt`), Array.from({ length: 40 + i }, (_, line) => `part ${i} line ${line + 1}: ${'filler text '.repeat(25)}`).join('\n') + '\n');
    },
    check: (dir) => read(dir, 'codename.txt').trim().includes('heron-9') && read(dir, 'log.txt').split('\n').filter(Boolean).length >= 12,
  },
];

const results = [];
for (const task of TASKS) {
  if (only && !only.includes(task.name)) continue;
  mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(join(work, `${task.name}-`));
  task.setup(dir);
  const started = Date.now();
  const run = spawnSync(process.execPath, [cli, '--json', 'send', '--harness', harness, ...(model ? ['--model', model] : []), '--permissions', 'bypass', task.prompt],
    { cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - started) / 1000);
  const reply = `${run.stdout ?? ''}`;
  let passed = false;
  try { passed = Boolean(task.check(dir, reply)); } catch { passed = false; }
  const note = run.error ? ` (${run.error.code ?? run.error.message})` : run.status ? ` (exit ${run.status}: ${String(run.stderr).trim().split('\n').pop()?.slice(0, 160)})` : '';
  results.push({ name: task.name, passed, seconds });
  console.log(`${passed ? 'pass' : 'FAIL'}  ${task.name.padEnd(11)} ${String(seconds).padStart(5)}s${note}`);
  if (!process.env.AGENT_CHECK_KEEP) rmSync(dir, { recursive: true, force: true }); else console.log(`      kept ${dir}`);
}
const passed = results.filter((row) => row.passed).length;
console.log(`${passed}/${results.length} passed on ${harness}${model ? ` ${model}` : ''} in ${results.reduce((sum, row) => sum + row.seconds, 0)}s`);
process.exit(passed === results.length ? 0 : 1);
