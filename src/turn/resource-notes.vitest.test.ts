import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { describe, expect, it } from 'vitest';
import { holdResourceNote, stripResourceNotes, withResourceNotes, wrapResourceNote } from './resource-notes.js';
import { normalizeImportedTranscript } from './failover-prompt.js';
import { LiveTurnInputBroker } from './live-input.js';

const savedHome = process.env.CLIKCODE_HOME;
let testHome: string;
beforeAll(() => { testHome = mkdtempSync(join(tmpdir(), 'clikcode-resource-notes-')); process.env.CLIKCODE_HOME = testHome; });
afterAll(() => { if (savedHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = savedHome; rmSync(testHome, { recursive: true, force: true }); });

describe('resource notes', () => {
  it('ride on the next turn once, ahead of its text', () => {
    holdResourceNote('s1', 'memory is tight');
    holdResourceNote('s1', 'a command was stopped');
    expect(existsSync(join(testHome, 'resource-notes', 's1.json'))).toBe(true);
    const sent = withResourceNotes('s1', 'fix the bug');
    expect(sent).toBe(`${wrapResourceNote('memory is tight')}\n${wrapResourceNote('a command was stopped')}\n\nfix the bug`);
    expect(withResourceNotes('s1', 'next')).toBe('next');
    expect(existsSync(join(testHome, 'resource-notes', 's1.json'))).toBe(false);
    expect(withResourceNotes('other', 'untouched')).toBe('untouched');
  });

  it('keeps the latest pending warning of each kind but preserves stop notices', () => {
    holdResourceNote('coalesced', 'Disk I/O is stalling the machine (5% full stall time). ClikCode has not identified your command.');
    holdResourceNote('coalesced', 'ClikCode stopped `npm test` for disk I/O pressure.');
    holdResourceNote('coalesced', 'Disk I/O is stalling the machine (20% full stall time). ClikCode has not identified your command.');
    holdResourceNote('coalesced', 'Memory is getting tight: 20 GB used.');
    holdResourceNote('coalesced', 'Memory is getting tight: 25 GB used.');
    holdResourceNote('coalesced', 'Disk is getting tight: 20 GB free.');
    holdResourceNote('coalesced', 'Disk is almost full: 5 GB free.');
    const sent = withResourceNotes('coalesced', 'continue');
    expect(sent).not.toContain('5% full stall');
    expect(sent).not.toContain('20 GB used');
    expect(sent).not.toContain('20 GB free');
    for (const text of ['ClikCode stopped `npm test`', '20% full stall', '25 GB used', '5 GB free', 'continue']) expect(sent).toContain(text);
  });

  it('never reach the transcript: cut off a turn, a steered-in one dropped', () => {
    holdResourceNote('s2', 'memory is tight');
    const sent = withResourceNotes('s2', 'fix the bug');
    expect(stripResourceNotes(sent)).toBe('fix the bug');
    const imported = normalizeImportedTranscript([
      { role: 'user', content: sent },
      { role: 'assistant', content: 'on it' },
      { role: 'user', content: wrapResourceNote('vitest was stopped at 9 GB') },
      { role: 'user', content: 'a <clikcode_resource_note> mid-message is the user\'s own text' },
    ]);
    expect(imported.map((message) => message.content)).toEqual([
      'fix the bug', 'on it', 'a <clikcode_resource_note> mid-message is the user\'s own text',
    ]);
  });

  it('steer into a running turn through its port, as a note and never queued', async () => {
    const broker = new LiveTurnInputBroker();
    expect(await broker.steerNote('nothing running')).toBe(false);
    const seen: { text: string; kind?: string }[] = [];
    broker.setSteerPort({ offer: async (text, submission) => { seen.push({ text, kind: submission.kind }); return true; } });
    expect(await broker.steerNote('memory is tight')).toBe(true);
    expect(seen).toEqual([{ text: 'memory is tight', kind: 'note' }]);
    broker.setSteerPort({ offer: async () => { throw new Error('turn ended'); } });
    expect(await broker.steerNote('too late')).toBe(false);
    broker.setSteerPort({ offer: async () => false });
    expect(await broker.steerNote('not a moment')).toBe(false);
  });
});
