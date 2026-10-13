import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { describe, expect, it } from 'vitest';
import { withResourceNotes } from '../turn/resource-notes.js';
import { createResourceNoteDelivery } from './resource-note-delivery.js';
import type { WorkerContext } from './worker-context.js';

const savedHome = process.env.CLIKCODE_HOME;
let testHome: string;
beforeAll(() => { testHome = mkdtempSync(join(tmpdir(), 'clikcode-resource-notes-')); process.env.CLIKCODE_HOME = testHome; });
afterAll(() => { if (savedHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = savedHome; rmSync(testHome, { recursive: true, force: true }); });

describe('resource notes to agents', () => {
  it('holds a stop reason for a vendor agent when no turn can steer it', async () => {
    const ctx = {
      sessionId: 'vendor-test',
      activeLiveInput: undefined,
      io: { currentSessionAndAccount: async () => ({ session: { provider: 'claude' }, account: {} }) },
    } as unknown as WorkerContext;
    createResourceNoteDelivery(ctx)('A test was stopped for memory');
    await new Promise((resolve) => setImmediate(resolve));
    expect(withResourceNotes('vendor-test', 'Continue')).toContain('A test was stopped for memory');
  });

  it('steers a note to a running vendor agent', async () => {
    const seen: string[] = [];
    const ctx = {
      sessionId: 'vendor-live-test',
      activeLiveInput: { steerNote: async (text: string) => { seen.push(text); return true; } },
      io: { currentSessionAndAccount: async () => ({ session: { provider: 'codex' }, account: {} }) },
    } as unknown as WorkerContext;
    createResourceNoteDelivery(ctx)('Memory is tight');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen[0]).toContain('Memory is tight');
    expect(withResourceNotes('vendor-live-test', 'Continue')).toBe('Continue');
  });

  it('also steers to ClikCode\'s own agent', async () => {
    const seen: string[] = [];
    const ctx = {
      sessionId: 'local-live-test',
      activeLiveInput: { steerNote: async (text: string) => { seen.push(text); return true; } },
      io: { currentSessionAndAccount: async () => ({ session: { route: 'clikcode-local' }, account: {} }) },
    } as unknown as WorkerContext;
    createResourceNoteDelivery(ctx)('Memory is tight');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen[0]).toContain('Memory is tight');
  });
});
