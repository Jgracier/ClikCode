import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refusalFromLog, silentRefusalReason } from './silent-refusal.js';

// Junie's own log line, for a JetBrains account with no AI plan.
const LINE = '2026-11-14 06:50:43.999 [JunieMain] WARN  GoogleResponseErrorHandler - Unexpected response: 403 Forbidden\n'
  + '        {"type":"NO_LICENSE","message":"No active JetBrains AI subscription found.\\nTo use Junie, you need an active JetBrains AI or JetBrains AI Pro subscription."}\n';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'refusal-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('why an agent gave up a prompt without a word', () => {
  it('reads the agent\'s own reason from its newest log', async () => {
    await mkdir(join(home, '.junie', 'logs'), { recursive: true });
    await writeFile(join(home, '.junie', 'logs', 'log-old.log'), '{"type":"OTHER","message":"stale"}');
    await utimes(join(home, '.junie', 'logs', 'log-old.log'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await writeFile(join(home, '.junie', 'logs', 'log-new.log'), LINE);
    expect(await silentRefusalReason('junie', { HOME: home }))
      .toBe('No active JetBrains AI subscription found. To use Junie, you need an active JetBrains AI or JetBrains AI Pro subscription.');
  });

  it('says nothing from an old log, a harness that declares none, or a log with no reason', async () => {
    await mkdir(join(home, '.junie', 'logs'), { recursive: true });
    await writeFile(join(home, '.junie', 'logs', 'log-a.log'), LINE);
    expect(await silentRefusalReason('junie', { HOME: home }, Date.now() + 3_600_000)).toBeUndefined();
    expect(await silentRefusalReason('codex', { HOME: home })).toBeUndefined();
    expect(refusalFromLog('INFO all fine', '\\{"type":"[A-Z_]+","message":"((?:[^"\\\\]|\\\\.)*)"')).toBeUndefined();
  });
});
