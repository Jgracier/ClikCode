import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configuredIdleMs, createTurnWatchdog } from './turn-watchdog.js';

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

  it('stays off unless a silence budget is configured', async () => {
    expect(configuredIdleMs({})).toBe(0);
    expect(configuredIdleMs({ CLIKCODE_TURN_IDLE_TIMEOUT_MS: '' })).toBe(0);
    expect(configuredIdleMs({ CLIKCODE_TURN_IDLE_TIMEOUT_MS: '600000' })).toBe(600_000);
    const previous = process.env.CLIKCODE_TURN_IDLE_TIMEOUT_MS;
    delete process.env.CLIKCODE_TURN_IDLE_TIMEOUT_MS;
    try {
      let fired = 0;
      const watchdog = createTurnWatchdog({ onIdle: () => { fired += 1; } });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fired).toBe(0);
      watchdog.stop();
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_TURN_IDLE_TIMEOUT_MS;
      else process.env.CLIKCODE_TURN_IDLE_TIMEOUT_MS = previous;
    }
  });

  it('still fails a turn that really went silent', async () => {
    let fired = 0;
    createTurnWatchdog({ idleMs: 30, onIdle: () => { fired += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fired).toBe(1);
  });
});
