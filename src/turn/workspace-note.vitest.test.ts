import { describe, expect, it } from 'vitest';
import { withWorkspaceNote } from './workspace-note.js';

describe('telling an agent with a folder of its own where the chat is', () => {
  it('names the chat\'s folder after the request', () => {
    const text = withWorkspaceNote({ turn: { ownWorkspace: true } } as never, 'create proof.txt', '/home/u/project');
    expect(text.startsWith('create proof.txt\n\n')).toBe(true);
    expect(text).toContain('/home/u/project');
  });

  it('adds nothing for an agent started in the folder, or a chat with none', () => {
    expect(withWorkspaceNote({ turn: {} } as never, 'hi', '/w')).toBe('hi');
    expect(withWorkspaceNote({} as never, 'hi', '/w')).toBe('hi');
    expect(withWorkspaceNote({ turn: { ownWorkspace: true } } as never, 'hi', undefined)).toBe('hi');
  });
});
