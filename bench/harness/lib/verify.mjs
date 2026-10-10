/** Helpers for a task's verify.mjs. A verify script runs with its cwd set to
 * the finished work copy and exits 0 only when the task is done. Hidden tests
 * live next to the task (never in the template), so an agent cannot see or
 * edit them. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const work = process.cwd();

export class Failure extends Error {}

/** Run the checks; print PASS or the first failure, and exit accordingly. */
export async function check(body) {
  try {
    await body();
    console.log('PASS');
    process.exit(0);
  } catch (error) {
    console.log(`FAIL: ${error instanceof Failure ? error.message : error?.stack ?? error}`);
    process.exit(1);
  }
}

export function fail(message) {
  throw new Failure(message);
}

/** The files the agent was told not to touch still match the template. */
export function filesUnchanged(taskDir, paths) {
  for (const path of paths) {
    const original = readFileSync(join(taskDir, 'template', path), 'utf8');
    const now = existsSync(join(work, path)) ? readFileSync(join(work, path), 'utf8') : null;
    if (now !== original) fail(`${path} was changed or removed`);
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: work, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => /not ok|Error|error|fail/i.test(line)).slice(0, 12).join('\n');
    fail(`${label} failed (exit ${result.status ?? result.signal})\n${output}`);
  }
  return result.stdout;
}

export function runNpmTest() {
  return run('npm', ['test', '--silent'], 'npm test');
}

/** Copy the task's hidden/ tests into the work copy, run them, remove them. */
export function runHidden(taskDir) {
  const target = join(work, '.bench-hidden');
  cpSync(join(taskDir, 'hidden'), target, { recursive: true });
  try {
    const files = readdirSync(target).filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.mjs'));
    return run('node', ['--test', ...files.map((name) => join('.bench-hidden', name))], 'hidden tests');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Every source file under the work copy (no .git, node_modules or hidden). */
export function sourceFiles(dir = work) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '.bench-hidden') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mjs|js|json|md)$/.test(name)) out.push(relative(work, path));
  }
  return out;
}

/** The files (relative paths) whose text matches the pattern. */
export function filesMatching(pattern, files = sourceFiles()) {
  return files.filter((path) => pattern.test(readFileSync(join(work, path), 'utf8')));
}
