import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts', 'vendor-sandbox.mjs');
const scratch: string[] = [];
const pids: number[] = [];
const scratchDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'vsb-test-')); scratch.push(dir); return dir; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done: () => boolean, ms = 10_000): Promise<void> => {
  for (let waited = 0; !done() && waited < ms; waited += 50) await new Promise((r) => setTimeout(r, 50));
};

afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vendor-sandbox', () => {
  it('on SIGTERM stops the command and deletes the sandbox', async () => {
    const out = scratchDir();
    const probe = `require('fs').writeFileSync(${JSON.stringify(join(out, 'info'))}, process.env.HOME + '\\n' + process.pid); setInterval(() => {}, 1000)`;
    const run = spawn('node', [script, '--', 'node', '-e', probe], { stdio: 'ignore', env: { ...process.env, TMPDIR: out } });
    const exited = new Promise<number | null>((r) => run.on('close', (code) => r(code)));
    await until(() => existsSync(join(out, 'info')));
    const [home, childPid] = readFileSync(join(out, 'info'), 'utf8').split('\n') as [string, string];
    pids.push(Number(childPid));
    expect(existsSync(home)).toBe(true);
    run.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(existsSync(home)).toBe(false);
    expect(alive(Number(childPid))).toBe(false);
  }, 30_000);

  it('signals a worker whose CLIKCODE_HOME is inside the sandbox before deleting it', async () => {
    const out = scratchDir();
    const probe = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); require('fs').writeFileSync(${JSON.stringify(join(out, 'pid'))}, String(c.pid))`;
    const run = spawnSync('node', [script, '--', 'node', '-e', probe], { env: { ...process.env, TMPDIR: out } });
    expect(run.status).toBe(0);
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8'));
    pids.push(pid);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('links every match of a glob in a catalog authFiles path (mcode)', () => {
    const out = scratchDir();
    const real = join(out, 'real');
    const auth = join(real, '.minimax', 'auth', 'prod', 'global', 'client1');
    mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, 'auth.json'), '{"accessToken":"x"}');
    const probe = `process.stdout.write(require('fs').readFileSync(process.env.HOME + '/.minimax/auth/prod/global/client1/auth.json', 'utf8'))`;
    const run = spawnSync('node', [script, '--auth', 'mcode', '--', 'node', '-e', probe], { env: { ...process.env, HOME: real, TMPDIR: out }, encoding: 'utf8' });
    expect(run.stdout).toBe('{"accessToken":"x"}');
  }, 30_000);

  it('says what to do for a harness that declares no sign-in files, and links a home-relative --link', () => {
    const out = scratchDir();
    const real = join(out, 'real');
    mkdirSync(join(real, '.config', 'x'), { recursive: true });
    writeFileSync(join(real, '.config', 'x', 'auth.json'), 'ok');
    const probe = `process.stdout.write(require('fs').readFileSync(process.env.HOME + '/.config/x/auth.json', 'utf8'))`;
    const run = spawnSync('node', [script, '--auth', 'devin', '--link', '.config/x/auth.json', '--', 'node', '-e', probe], { env: { ...process.env, HOME: real, TMPDIR: out }, encoding: 'utf8' });
    expect(run.stderr).toMatch(/devin declares no sign-in files.*--link <~\/path>/);
    expect(run.stderr).toContain('WINDSURF_API_KEY');
    expect(run.stdout).toBe('ok');
  }, 30_000);
});
