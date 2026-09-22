import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADOPTED_TRANSCRIPT_READERS } from './registry.js';
import { mergeNativeTranscript, type NativeTranscriptMessage } from './transcript.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';

const message = (role: NativeTranscriptMessage['role'], content: string): NativeTranscriptMessage => ({ role, content });

describe('mergeNativeTranscript', () => {
  it('adopts a source transcript when the local cache is empty', () => {
    const source = [message('user', 'one'), message('assistant', 'two')];
    expect(mergeNativeTranscript([], source)).toEqual(source);
  });

  it('appends turns written to the native source after the cached suffix', () => {
    const cached = [message('user', 'one'), message('assistant', 'two')];
    const source = [
      message('assistant', 'older bounded-window entry'),
      ...cached,
      message('user', 'continued outside ClikCode'),
      message('assistant', 'source answer'),
    ];
    expect(mergeNativeTranscript(cached, source)).toEqual([
      ...cached,
      message('user', 'continued outside ClikCode'),
      message('assistant', 'source answer'),
    ]);
  });

  it('does not erase transported context when a linked source has no overlap', () => {
    const cached = [message('user', 'context replayed from another provider'), message('assistant', 'answer')];
    const unrelated = [message('user', 'different branch'), message('assistant', 'different answer')];
    expect(mergeNativeTranscript(cached, unrelated)).toEqual(cached);
  });

  it('is idempotent after source additions have been merged', () => {
    const source = [message('user', 'one'), message('assistant', 'two')];
    expect(mergeNativeTranscript(source, source)).toEqual(source);
  });

  it('still syncs new vendor turns when only whitespace differs on the last cached message', () => {
    // The live stream inserts a blank line between text blocks a tool call
    // split apart; the vendor's own stored copy of the same answer joins them
    // without it. Every overlap window this search tries is a SUFFIX of
    // `cached`, so it always includes that last, differently-formatted
    // message -- an exact match therefore failed at every window length, not
    // just the longest one, and the whole merge fell back to `[...cached]`,
    // silently dropping every genuinely new turn the vendor had recorded
    // after it. Not a duplicate -- a missed sync.
    const cached = [
      message('user', 'a'),
      message('assistant', 'First part.\n\nSecond part.'),
    ];
    const source = [
      ...cached.map((m) => m.role === 'assistant' ? message('assistant', 'First part. Second part.') : m),
      message('user', 'new question'),
      message('assistant', 'new answer'),
    ];
    expect(mergeNativeTranscript(cached, source)).toEqual([
      ...cached,
      message('user', 'new question'),
      message('assistant', 'new answer'),
    ]);
  });

  it('reads Codex transcripts from the linked account CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-codex-profile-'));
    const nativeId = '01999999-9999-7999-8999-999999999999';
    const sessionDir = join(root, 'sessions', '2026', '09', '18');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `rollout-test-${nativeId}.jsonl`), [
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>synthetic</recommended_plugins>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## Open tabs:\n- app.ts\n\n## My request:\nprofile prompt' }] } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'profile answer' }] } }),
    ].join('\n'));
    const harness = { command: 'codex' } as AiLocalHarnessDefinition;
    try {
      await expect(ADOPTED_TRANSCRIPT_READERS.codex!(harness, nativeId, '/workspace', { CODEX_HOME: root }))
        .resolves.toEqual([message('user', 'profile prompt'), message('assistant', 'profile answer')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
