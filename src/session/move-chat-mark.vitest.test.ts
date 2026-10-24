import { describe, expect, it } from 'vitest';
import { moveChat, type MoveEnd, type MoveRequest } from './move-chat.js';

const chatExport = { version: 1, sessionId: 's1', conversationId: 'c1', createdAt: '', messages: [{ role: 'user', content: 'hi' }], settings: {}, source: {} };

/** Two stand-in ends: the source fails `markFailures` times at mark-moved. */
const ends = (markFailures: number) => {
  const marks: MoveRequest[] = [];
  let failed = 0;
  const source: MoveEnd = {
    name: 'linux',
    call: async <T>(request: MoveRequest): Promise<T> => {
      if (request.type === 'export-chat') return chatExport as T;
      if (request.type === 'mark-moved') {
        marks.push(request);
        if (failed < markFailures) { failed += 1; throw new Error('The connection to linux ended'); }
      }
      return undefined as T;
    },
  };
  const target: MoveEnd = {
    name: 'imac',
    call: async <T>(request: MoveRequest): Promise<T> => (request.type === 'import-chat' ? { sessionId: 's1', installationId: 'i2', folder: '/w', changes: [] } as T : undefined as T),
  };
  return { source, target, marks };
};

describe('marking the old copy moved, the third step of a move', () => {
  it('is tried again when the connection drops once, and the move completes', async () => {
    const { source, target, marks } = ends(1);
    await expect(moveChat(source, target, 's1')).resolves.toMatchObject({ moved: true, sessionId: 's1' });
    expect(marks).toHaveLength(2);
    expect(marks[1]).toMatchObject({ type: 'mark-moved', movedTo: { machine: 'imac', installationId: 'i2' } });
  });

  it('says exactly what state it left when it cannot be done: on the target, still writable on the source', async () => {
    const { source, target, marks } = ends(10);
    const failure = await moveChat(source, target, 's1').then(() => '', (error: Error) => error.message);
    expect(marks).toHaveLength(3);
    expect(failure).toContain('The chat is on imac');
    expect(failure).toContain('copy on linux could not be marked as moved: The connection to linux ended');
    expect(failure).toContain('Both copies are still writable');
  }, 15_000);
});
