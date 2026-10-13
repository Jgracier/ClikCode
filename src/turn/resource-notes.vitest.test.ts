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

  it('steer into a running turn through its handler, which is told it is a note', async () => {
    const broker = new LiveTurnInputBroker();
    expect(await broker.steerNote('nothing running')).toBe(false);
    const seen: { text: string; kind?: string }[] = [];
    broker.setSteerHandler(async (text, submission, hold) => {
      await hold(() => false);
      seen.push({ text, kind: submission.kind });
    });
    expect(await broker.steerNote('memory is tight')).toBe(true);
    expect(seen).toEqual([{ text: 'memory is tight', kind: 'note' }]);
    broker.setSteerHandler(async () => { throw new Error('turn ended'); });
    expect(await broker.steerNote('too late')).toBe(false);
  });
});
