/** A Codex thread that goes to `systemError` with no text of its own says why:
 * the account's spent-plan snapshot (usage limit) or the child's stderr (401),
 * carried as structured fields the failover classifier reads. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codexUsageLimitRefusal, createCodexSession } from './codex-app-server.js';
import { classifyAccountFailure } from '../../turn/failover.js';

type Step = { send?: Record<string, unknown>; stderr?: string };

function fakeServer(steps: Step[], read?: Record<string, unknown>): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const steps = ${JSON.stringify(steps)};
    const read = ${JSON.stringify(read ?? null)};
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'U1' } } });
        (async () => { for (const step of steps) { if (step.stderr) { process.stderr.write(step.stderr); await new Promise((r) => setTimeout(r, 150)); } if (step.send) send(step.send); } })();
      } else if (m.method === 'account/rateLimits/read') send(read ? { id: m.id, result: read } : { id: m.id, error: { code: -32601, message: 'unknown method' } });
      else if (m.id !== undefined) send({ id: m.id, result: {} });
    } });
  `;
}

const run = (steps: Step[], read?: Record<string, unknown>) => createCodexSession({
  spawn: (_binary, _argv, spawnOptions) => spawn(process.execPath, ['-e', fakeServer(steps, read)], spawnOptions),
}).runTurn({ binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask' });

const systemError = { method: 'thread/status/changed', params: { threadId: 'T', status: { type: 'systemError' } } };

describe('a Codex thread that ends in systemError', () => {
  it('reads a spent plan from the rate-limit snapshot', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const error = await run([
      { send: { method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, resetsAt }, secondary: { usedPercent: 40 } } } } },
      { send: systemError },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string; codexErrorInfo?: unknown };
    expect(error.message).toMatch(/hit your usage limit.*Try again at/);
    expect(error.errorKind).toBe('quota');
    expect(error.codexErrorInfo).toBe('usageLimitExceeded');
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  // The order codex-cli 0.162.1 sends a spent plan in (captured 2026-10-20): the plan's snapshot, then
  // `premium`'s with no windows, then systemError, and only then the reason and turn/completed.
  const limitSaid = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 10:35 AM.";
  const premium = { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'premium', primary: null, secondary: null, credits: { hasCredits: false, balance: '0' }, rateLimitReachedType: null } } };

  it('ends on the reason Codex sends after the systemError, and the account is spent', async () => {
    const error = await run([
      { send: { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 98 }, secondary: { usedPercent: 18 } } } } },
      { send: premium },
      { send: systemError },
      { send: { method: 'error', params: { error: { message: limitSaid, codexErrorInfo: 'usageLimitExceeded' }, willRetry: false, threadId: 'T', turnId: 'U1' } } },
      { send: { method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U1', status: 'failed', error: { message: limitSaid, codexErrorInfo: 'usageLimitExceeded' } } } } },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string; codexErrorInfo?: unknown };
    expect(error.message).toBe(limitSaid);
    expect(error.codexErrorInfo).toBe('usageLimitExceeded');
    expect(error.errorKind).toBe('quota');
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  it('asks for the rate limits when no reason comes, and reads the plan spent', async () => {
    const error = await run([{ send: premium }, { send: systemError }], {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, rateLimitReachedType: 'rate_limit_reached' },
    }).catch((caught: Error) => caught) as Error & { errorKind?: string };
    expect(error.message).toMatch(/hit your usage limit/);
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  it('keeps the plan at 100% when a snapshot with no windows comes after it', async () => {
    const error = await run([
      { send: { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100 }, secondary: { usedPercent: 18 } } } } },
      { send: premium },
      { send: systemError },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string };
    expect(error.message).toMatch(/hit your usage limit/);
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  it('keeps the structured codexErrorInfo of the thread error', async () => {
    const error = await run([
      { send: { method: 'error', params: { error: { codexErrorInfo: 'unauthorized' }, willRetry: false } } },
      { send: systemError },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string; codexErrorInfo?: unknown };
    expect(error.codexErrorInfo).toBe('unauthorized');
    expect(error.errorKind).toBe('auth');
    expect(classifyAccountFailure(error)).toBe('authentication-required');
  });

  it('uses the stderr tail to classify but never in the message', async () => {
    const error = await run([
      { stderr: 'ERROR: unexpected status 401 Unauthorized: Missing bearer\n' },
      { send: systemError },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string; stderrTail?: string };
    expect(error.message).toBe('Codex reported a system error on this thread');
    expect(error.stderrTail).toMatch(/401/);
    expect(error.errorKind).toBe('auth');
  });

  it('reads no refusal from a snapshot with room left', () => {
    expect(codexUsageLimitRefusal({ primary: { usedPercent: 20 }, secondary: { usedPercent: 99 } })).toBeUndefined();
    expect(codexUsageLimitRefusal({ rateLimitReachedType: 'primary' })?.codexErrorInfo).toBe('usageLimitExceeded');
  });
});
