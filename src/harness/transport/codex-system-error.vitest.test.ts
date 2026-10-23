/** A Codex thread that goes to `systemError` with no text of its own says why:
 * the account's spent-plan snapshot (usage limit) or the child's stderr (401),
 * carried as structured fields the failover classifier reads. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codexUsageLimitRefusal, createCodexSession } from './codex-app-server.js';
import { classifyAccountFailure } from '../../turn/failover.js';

type Step = { send?: Record<string, unknown>; stderr?: string };

function fakeServer(steps: Step[]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const steps = ${JSON.stringify(steps)};
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'U1' } } });
        (async () => { for (const step of steps) { if (step.stderr) { process.stderr.write(step.stderr); await new Promise((r) => setTimeout(r, 150)); } if (step.send) send(step.send); } })();
      }
    } });
  `;
}

const run = (steps: Step[]) => createCodexSession({
  spawn: (_binary, _argv, spawnOptions) => spawn(process.execPath, ['-e', fakeServer(steps)], spawnOptions),
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

  it('reads the usage limit from the error that follows systemError', async () => {
    const error = await run([
      { send: systemError },
      { send: { method: 'error', params: { error: { message: "You've hit your usage limit. Try again at Oct 22nd, 2026 3:13 PM.", codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } } },
      { send: { method: 'turn/completed', params: { turn: { id: 'U1', status: 'completed' } } } },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string; codexErrorInfo?: unknown };
    expect(error.message).toMatch(/hit your usage limit/);
    expect(error.codexErrorInfo).toBe('usageLimitExceeded');
    expect(error.errorKind).toBe('quota');
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  it('still reads the usage limit when turn/completed arrives before that error', async () => {
    const error = await run([
      { send: systemError },
      { send: { method: 'turn/completed', params: { turn: { id: 'U1', status: 'completed' } } } },
      { send: { method: 'error', params: { error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } } },
    ]).catch((caught: Error) => caught) as Error & { errorKind?: string };
    expect(error.message).toMatch(/hit your usage limit/);
    expect(error.errorKind).toBe('quota');
    expect(classifyAccountFailure(error)).toBe('quota-exhausted');
  });

  it('lets a retried turn finish after systemError', async () => {
    const result = await run([
      { send: systemError },
      { send: { method: 'error', params: { error: { message: 'stream reset' }, willRetry: true } } },
      { send: { method: 'item/agentMessage/delta', params: { delta: 'done' } } },
      { send: { method: 'turn/completed', params: { turn: { id: 'U1', status: 'completed' } } } },
    ]);
    expect(result.text).toBe('done');
  });

  it('reads no refusal from a snapshot with room left', () => {
    expect(codexUsageLimitRefusal({ primary: { usedPercent: 20 }, secondary: { usedPercent: 99 } })).toBeUndefined();
    expect(codexUsageLimitRefusal({ rateLimitReachedType: 'primary' })?.codexErrorInfo).toBe('usageLimitExceeded');
    expect(codexUsageLimitRefusal({ primary: null, rateLimitsByLimitId: { codex: { primary: { used_percent: 100, resets_at: 1_700_000_000 } } } })?.codexErrorInfo).toBe('usageLimitExceeded');
    expect(codexUsageLimitRefusal({ ordinaryUsageAllowed: false })?.codexErrorInfo).toBe('usageLimitExceeded');
    expect(codexUsageLimitRefusal({ spendControlReached: true })?.message).toMatch(/usage limit/);
    const rateLimited = codexUsageLimitRefusal({ rateLimitReachedType: 'rate_limit_reached' });
    expect(rateLimited?.codexErrorInfo).toBe('rateLimitExceeded');
    expect(classifyAccountFailure(Object.assign(new Error(rateLimited!.message), { errorKind: 'other', codexErrorInfo: rateLimited!.codexErrorInfo }))).toBe('temporarily-throttled');
  });
});
