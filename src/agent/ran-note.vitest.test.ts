import { describe, expect, it } from 'vitest';
import { callsAsUserNotes, ranNote } from './ran-note.js';

const user = (text: string) => ({ type: 'text' as const, role: 'user' as const, text });
const assistant = (text: string) => ({ type: 'text' as const, role: 'assistant' as const, text });

describe('calls told on the user side', () => {
  it('rewrites an old "[Tool calls: ...]" line in the assistant words into a note on the request', () => {
    const out = callsAsUserNotes([user('Fix it'), assistant('[Tool calls: Edit a.ts; $ npm test]\n\nDone.')]);
    expect(out[0]!.text).toBe(`Fix it${ranNote(['Edit a.ts; $ npm test'])}`);
    expect(out[1]!.text).toBe('Done.');
    expect(JSON.stringify(out)).not.toContain('[Tool calls');
  });

  it('keeps a reply that was only the calls line as an empty reply, not as the pattern', () => {
    expect(callsAsUserNotes([user('Go'), assistant('[Tool calls: Read b.ts]')])[1]!.text).toBe('(no reply)');
  });

  it('leaves memory that already has the note, and an assistant line with no request before it, alone', () => {
    const fresh = [user('Fix it\n\n(ClikCode note, not the user\'s words: answering this, the assistant ran Edit a.ts.)'), assistant('Done.')];
    expect(callsAsUserNotes(fresh)).toEqual(fresh);
    const orphan = [assistant('[Tool calls: Read b.ts]\n\nHi.')];
    expect(callsAsUserNotes(orphan)).toEqual(orphan);
  });
});
