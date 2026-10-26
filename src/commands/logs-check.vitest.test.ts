import { describe, expect, it } from 'vitest';
import { formatHealth, healthReport, type HealthEntry } from './logs-check.js';

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 26, 10, minute)).toISOString();
const entry = (minute: number, pid: number, event: string, fields: Record<string, unknown> = {}): HealthEntry => ({ t: at(minute), pid, role: 'command', event, ...fields });

describe('logs --check', () => {
  it('names the command that keeps failing and who starts it, from the exit line alone or from its start', () => {
    const entries = [
      entry(0, 10, 'process.start', { argv: 'swarm-mcp', parent: 'claude' }), entry(0, 10, 'process.exit', { code: 1 }),
      entry(5, 11, 'process.start', { argv: 'swarm-mcp', parent: 'claude' }), entry(5, 11, 'process.exit', { code: 1, argv: 'swarm-mcp', parent: 'claude' }),
      entry(6, 12, 'process.start', { argv: 'logs' }), entry(6, 12, 'process.exit', { code: 0 }),
    ];
    const report = healthReport(entries);
    expect(report.processes.abnormal).toEqual([{ what: 'swarm-mcp', code: 1, parent: 'claude', count: 2 }]);
    expect(report.findings).toContain('`swarm-mcp` exited 1 2 times, started by claude.');
  });

  it('groups failed tool calls by name and whether a sub-agent made them, with why', () => {
    const entries = Array.from({ length: 4 }, (_, index) => entry(index, 20, 'turn.tool', { name: 'Bash', ok: false, child: true, err: 'This agent is isolated in the worktree' }));
    entries.push(entry(9, 20, 'turn.tool', { name: 'Read', ok: true }));
    const report = healthReport(entries);
    expect(report.tools).toMatchObject({ total: 5, failed: 4, failures: [{ name: 'Bash', child: true, count: 4, sample: 'This agent is isolated in the worktree' }] });
    expect(report.findings[0]).toBe('4 `Bash` calls failed inside a sub-agent: This agent is isolated in the worktree.');
  });

  it('counts swallowed errors with the ones a minute rolled up, retired launches, and processes that vanished', () => {
    const entries = [
      entry(0, 30, 'swallowed', { area: 'worker/registry', errno: 'EACCES', message: 'denied' }),
      entry(1, 30, 'swallowed', { area: 'worker/registry', more: 4 }),
      entry(2, 31, 'mcp.retired.launch', { command: 'conversations-mcp', parent: 'cline' }),
      entry(0, 40, 'process.start', { argv: 'ide-bridge' }),
      entry(0, 41, 'process.start', { argv: 'session-worker x' }), entry(1, 41, 'process.exit', { code: 0 }),
    ];
    const report = healthReport(entries, (pid) => pid !== 40, Date.UTC(2026, 9, 26, 12));
    expect(report.swallowed).toEqual([{ area: 'worker/registry', count: 6, errno: 'EACCES', sample: 'denied' }]);
    expect(report.retiredLaunches).toEqual([{ command: 'conversations-mcp', parent: 'cline', count: 1 }]);
    expect(report.processes.vanished).toBe(1);
    expect(report.findings.some((line) => line.includes('6 errors swallowed in worker/registry (EACCES)'))).toBe(true);
    expect(report.findings.some((line) => line.includes('retired `conversations-mcp` (started by cline)'))).toBe(true);
  });

  it('does not call a process that was ended by a signal one that vanished', () => {
    const report = healthReport([entry(0, 50, 'process.start', { argv: 'ide-bridge' }), entry(1, 50, 'process.signal', { signal: 'SIGTERM', argv: 'ide-bridge' })], () => false, Date.UTC(2026, 9, 26, 12));
    expect(report.processes).toMatchObject({ vanished: 0, signals: { 'SIGTERM ide-bridge': 1 } });
  });

  it('says so when nothing is wrong', () => {
    const text = formatHealth(healthReport([entry(0, 1, 'worker.turn.end', { outcome: 'completed' })]));
    expect(text).toContain('Nothing needs attention.');
    expect(text).toContain('Turns: 1 completed');
  });
});
