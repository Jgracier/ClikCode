import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { reportingExit, scriptResult } from './ssh.js';

describe("a script's exit status, however the other side's ssh reports it", () => {
  it('is what the script exited with, said on stderr: Tailscale SSH to a Mac says 0 for everything', () => {
    // As that ssh does: the command runs, its status is dropped.
    const run = spawnSync('sh', ['-c', `${reportingExit('echo out; echo err >&2; exit 6')}; exit 0`], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(scriptResult(run.status!, run.stdout, run.stderr)).toEqual({ code: 6, stdout: 'out\n', stderr: 'err\n' });
  });

  it('runs under sh whatever the login shell is, and a script that ends well is 0', () => {
    const out = execFileSync('sh', ['-c', reportingExit("printf '%s' \"it's\"")], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBe("it's");
    const run = spawnSync('sh', ['-c', reportingExit('true')], { encoding: 'utf8' });
    expect(scriptResult(run.status!, run.stdout, run.stderr).code).toBe(0);
  });

  it("keeps ssh's own failure, and a script cut off is not a success", () => {
    expect(scriptResult(255, '', 'ssh: connect to host x: Connection refused\n')).toMatchObject({ code: 255 });
    expect(scriptResult(0, 'half', '')).toMatchObject({ code: 1, stderr: 'the command did not finish on the other machine' });
  });
});
