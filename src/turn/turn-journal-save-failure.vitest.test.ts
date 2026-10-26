import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, HarnessState } from '../session/model.js';

const disk = vi.hoisted(() => ({ failing: true }));
vi.mock('../session/state/write.js', () => ({
  writeState: vi.fn(async () => { if (disk.failing) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }),
  writeTranscriptCheckpoint: vi.fn(async () => false),
}));
vi.mock('../runtime/lifecycle-log.js', () => ({ lifecycle: vi.fn(), diagnostic: vi.fn(), quiet: () => () => undefined, swallowed: () => undefined }));

import { DurableTurnCheckpoint } from './turn-journal.js';

const session = (): HarnessSession => ({ id: 's1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Chat', createdAt: '', updatedAt: '', status: 'active', messages: [] } as unknown as HarnessSession);

afterEach(() => { disk.failing = true; });

describe('a turn whose conversation cannot be saved', () => {
  it('says so once, with the errno text, and again after a save has landed', async () => {
    const state = { sessions: [session()] } as unknown as HarnessState;
    const checkpoint = await DurableTurnCheckpoint.start(state, state.sessions[0]!, 'hello');
    const said: string[] = [];
    checkpoint.notify = (message) => said.push(message);
    await checkpoint.persistNow().catch(() => undefined);
    await checkpoint.complete('answer');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('could not be saved: ENOSPC: no space left on device');
    // The disk is back: the next failure after a landed write is said again.
    disk.failing = false;
    await checkpoint.persistNow();
    disk.failing = true;
    await checkpoint.persistNow().catch(() => undefined);
    await checkpoint.complete('again').catch(() => undefined);
    expect(said).toHaveLength(2);
  });
});
