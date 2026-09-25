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
