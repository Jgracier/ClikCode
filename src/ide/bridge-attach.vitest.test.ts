/** A message that names uploaded files: images go to the turn for the model to see, any other file is kept with the
 * conversation and named to the agent, and the message is a turn of its own. Real state, real uploads; the worker is a fake. */
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { IdeUploads } from './upload.js';

const { BridgeTurns } = await import('./bridge-turns.js');
const { writeState } = await import('../session/state/write.js');
const { readState } = await import('../session/state/read.js');

const session: HarnessSession = {
  id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet', effort: 'auto',
  permissionMode: 'auto', messages: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
} as unknown as HarnessSession;

const previousHome = process.env.CLIKCODE_HOME;
let uploads: IdeUploads;
beforeEach(async () => {
  process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-attach-'));
  await writeState({ sessions: [session], accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' } } as unknown as HarnessState);
  uploads = new IdeUploads();
});
afterEach(async () => {
  await uploads.close();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previousHome;
});

async function upload(id: string, name: string, body: string): Promise<string> {
  await uploads.start(id, name, Buffer.byteLength(body));
  await uploads.append(id, 0, Buffer.from(body).toString('base64'));
  return uploads.finish(id);
}

/** A bridge whose worker is mid-turn: what `send` hands it is what would be steered or queued. */
function bridge() {
  const toWorker: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const reported: unknown[] = [];
  const host = {
    channel: { send: (message: Record<string, unknown>) => { sent.push(message); } },
    sessionId: 's1', requireSession: () => 's1',
    current: async () => ({ session }),
    report: (error: unknown) => { reported.push(error); },
    link: { workerTurnRunning: true, worker: { sessionId: 's1', client: { send: (command: Record<string, unknown>) => { toWorker.push(command); } } } },
  };
  return { turns: new BridgeTurns(host as never, uploads), toWorker, sent, reported };
}

describe('a message that names uploaded files', () => {
  it('queues an image for the model and leaves the words as typed', async () => {
    const path = await upload('upload-0001', 'shot.png', 'png bytes');
    const { turns, toWorker, reported } = bridge();
    await turns.send('what is this?', 'm1', 'steer', [path]);
    expect(reported).toEqual([]);
    const kept = (await readState({ transcripts: ['s1'] })).sessions[0]!.attachments!;
    expect(kept).toHaveLength(1);
    expect(await readFile(kept[0]!, 'utf8')).toBe('png bytes');
    expect(existsSync(path)).toBe(false);
    // Steered into the running turn its text would arrive without the image: it is queued behind it instead.
    expect(toWorker).toEqual([{ type: 'steer', text: 'what is this?', id: 'm1', mode: 'queue' }]);
  });

  it('keeps any other file with the conversation and tells the agent where it is', async () => {
    const path = await upload('upload-0001', 'clip.mp4', 'video bytes');
    const { turns, toWorker } = bridge();
    await turns.send('trim the first second', undefined, undefined, [path]);
    const text = String(toWorker[0]!.text);
    const [words, reference] = text.split('\n');
    expect(words).toBe('trim the first second');
    const kept = reference!.replace('Attached file: ', '');
    expect(kept.endsWith('/clip.mp4')).toBe(true);
    expect(await readFile(kept, 'utf8')).toBe('video bytes');
    expect((await readState({ transcripts: ['s1'] })).sessions[0]!.attachments ?? []).toEqual([]);
  });

  it('gives an image sent with no words something to be asked', async () => {
    const { turns, toWorker } = bridge();
    await turns.send('', undefined, undefined, [await upload('upload-0001', 'a.png', 'x')]);
    expect(toWorker[0]!.text).toBe('Look at the attached image.');
  });

  it('refuses a path this bridge did not stage, and sends nothing', async () => {
    const { turns, toWorker, sent, reported } = bridge();
    await turns.send('read this', 'm1', undefined, ['/etc/passwd']);
    expect(toWorker).toEqual([]);
    expect(String(reported[0])).toContain('expired');
    expect(sent.some((message) => message.type === 'restore-draft')).toBe(true);
  });
});
