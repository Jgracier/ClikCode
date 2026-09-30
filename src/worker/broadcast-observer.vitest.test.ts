import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BroadcastObserver } from './broadcast-observer';

function fakeClient(): { socket: Socket; frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const socket = { write: (frame: string) => { frames.push(JSON.parse(frame)); return true; } } as unknown as Socket;
  return { socket, frames };
}

describe('sign-in from a worker', () => {
  const request = { command: 'hermes', argv: ['auth', 'add', 'nous'], environment: {}, name: 'Hermes › nous' };

  it('asks the attached window to run the sign-in and waits for its answer', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    const signedIn = observer.signIn(request);
    const sent = client.frames.find((frame) => frame.type === 'sign-in-request') as { id: string } & typeof request;
    expect(sent).toMatchObject(request);
    observer.resolveSignIn(sent.id);
    await expect(signedIn).resolves.toBeUndefined();
  });

  it('fails the sign-in the window reports failed', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    const signedIn = observer.signIn(request);
    const sent = client.frames.find((frame) => frame.type === 'sign-in-request') as { id: string };
    observer.resolveSignIn(sent.id, 'hermes exited with status 1');
    await expect(signedIn).rejects.toThrow('hermes exited with status 1');
  });

  it('fails at once with no window to run it in', async () => {
    await expect(new BroadcastObserver().signIn(request)).rejects.toThrow('needs an open ClikCode window');
  });
});

describe('a request nobody has answered yet', () => {
  it('is asked again of a window that attaches later, and the answer still reaches the turn', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'fix it');
    // Asked with nobody attached: it used to go nowhere, for ever.
    const approved = observer.approval('Run npm test?', 'npm test', undefined, 'Bash(npm test:*)');
    const late = fakeClient();
    observer.attach(late.socket);
    observer.reofferPending(late.socket);
    const asked = late.frames.find((frame) => frame.type === 'approval-request') as { id: string };
    expect(asked).toMatchObject({ title: 'Run npm test?', detail: 'npm test', rule: 'Bash(npm test:*)' });
    observer.resolveApproval(asked.id, 'always');
    await expect(approved).resolves.toBe('always');
    // Answered: not offered to the next window.
    const later = fakeClient();
    observer.reofferPending(later.socket);
    expect(later.frames).toEqual([]);
  });

  it('re-offers a sign-in to a window attaching after the one that was asked left', async () => {
    const observer = new BroadcastObserver();
    const first = fakeClient();
    observer.attach(first.socket);
    const signedIn = observer.signIn({ command: 'hermes', argv: [], environment: {}, name: 'Hermes' });
    observer.detach(first.socket);
    const second = fakeClient();
    observer.attach(second.socket);
    observer.reofferPending(second.socket);
    const asked = second.frames.find((frame) => frame.type === 'sign-in-request') as { id: string };
    expect(asked).toMatchObject({ command: 'hermes' });
    observer.resolveSignIn(asked.id);
    await expect(signedIn).resolves.toBeUndefined();
  });

  it('is refused when its turn ends, so nothing is left waiting', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking');
    const approved = observer.approval('Write a.txt?');
    observer.stopWaiting();
    await expect(approved).resolves.toBe(false);
    expect(observer.pendingRequestCount).toBe(0);
  });

  it('names the running prompt in waiting-start and in the live snapshot', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', '[background shell bash_1 exited (code 0)] make');
    expect(client.frames[0]).toEqual({ type: 'waiting-start', message: 'thinking', prompt: '[background shell bash_1 exited (code 0)] make' });
    expect(observer.liveSnapshot()).toMatchObject({ prompt: '[background shell bash_1 exited (code 0)] make' });
  });
});

describe('a notice about the turn', () => {
  it('reaches every window as a line of the transcript, not as a passing thought', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking');
    observer.activity('The answer was cut off: the model reached its output limit.');
    expect(client.frames.at(-1)).toEqual({ type: 'note', message: 'The answer was cut off: the model reached its output limit.' });
    expect(observer.turnOutputStarted).toBe(true);
  });
});
