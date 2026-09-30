import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import { readAcpUsageFile } from './acp-usage-file.js';
import { turnShareOf } from '../protocol/turn-usage.js';

const home = await mkdtemp(join(tmpdir(), 'cc-usage-file-'));
afterAll(() => rm(home, { recursive: true, force: true }));

const cline = AI_LOCAL_HARNESSES.find((harness) => harness.command === 'cline')!.acp!.usageFile!;
const id = '1790548663848_449c-_cli';

async function write(usage: Record<string, number>): Promise<void> {
  await mkdir(join(home, '.cline/data/sessions', id), { recursive: true });
  // The fields Cline 3.0.65 writes, from a session ClikCode ran over ACP.
  await writeFile(join(home, '.cline/data/sessions', id, `${id}.json`), JSON.stringify({
    version: 1, session_id: id, source: 'cli', interactive: true, provider: 'cline', status: 'running',
    metadata: { usage, aggregateUsage: usage, totalCost: usage.totalCost },
  }));
}

describe("Cline's session file as its usage source", () => {
  it('reads metadata.usage, cost included', async () => {
    await write({ inputTokens: 4448, outputTokens: 101, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.009906 });
    expect(await readAcpUsageFile(cline, id, { HOME: home })).toEqual({ input: 4448, output: 101, cacheRead: 0, cacheWrite: 0, costUsd: 0.009906 });
  });

  it("a turn's usage is what the session's total grew by", async () => {
    const before = await readAcpUsageFile(cline, id, { HOME: home });
    await write({ inputTokens: 9068, outputTokens: 107, cacheReadTokens: 4446, cacheWriteTokens: 0, totalCost: 0.0112032 });
    const after = await readAcpUsageFile(cline, id, { HOME: home });
    const share = turnShareOf(after!, before!);
    expect(share).toMatchObject({ input: 4620, output: 6, cacheRead: 4446, cacheWrite: 0 });
    expect(share.costUsd).toBeCloseTo(0.0012972, 7);
  });

  it('nothing for a session with no file, or an id that is not a file name', async () => {
    expect(await readAcpUsageFile(cline, 'missing', { HOME: home })).toBeUndefined();
    expect(await readAcpUsageFile(cline, '../../etc', { HOME: home })).toBeUndefined();
  });
});
