import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createTurnWatchdog } from './turn-watchdog.js';

describe('the turn watchdog', () => {
  it('does not fail a turn whose vendor spoke while this process was not running', async () => {
    // An echo child: what is written comes straight back on stdout.
    const echo = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      echo.stdin.write('ready\n');
      await new Promise((resolve) => echo.stdout.once('data', resolve));
      let idle = false;
      const watchdog = createTurnWatchdog({ idleMs: 100, onIdle: () => { idle = true; } });
      echo.stdout.on('data', () => watchdog.activity());
      echo.stdin.write('vendor message\n');
      // This process is busy past the budget; the message arrives meanwhile.
      const until = Date.now() + 400;
      while (Date.now() < until) { /* starved */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(idle).toBe(false);
      watchdog.stop();
    } finally {
      echo.kill();
    }
  });

  it('still fails a turn that really went silent', async () => {
    let fired = 0;
    createTurnWatchdog({ idleMs: 30, onIdle: () => { fired += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fired).toBe(1);
  });
});
