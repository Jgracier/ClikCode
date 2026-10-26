import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADOPTED_TRANSCRIPT_READERS } from './registry.js';
import { readClaudeFsTranscript, readClaudeFsTranscriptForSync } from './vendors/claude.js';
import { mergeNativeTranscript, reconcileNativeTranscript, visibleNativeUserText, type NativeTranscriptMessage } from './transcript.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';

const message = (role: NativeTranscriptMessage['role'], content: string): NativeTranscriptMessage => ({ role, content });

describe('mergeNativeTranscript', () => {
  it('reconciles long repeated histories and chooses their most recent overlap', () => {
    const repeated = Array.from({ length: 10_000 }, () => message('assistant', 'repeated'));
    const cached = [message('user', 'missing prefix'), ...repeated];
    const source = [...repeated, message('user', 'new request')];
    expect(mergeNativeTranscript(cached, source)).toEqual([...cached, source.at(-1)!]);
    expect(mergeNativeTranscript([message('assistant', 'same')], [message('assistant', 'same'), message('user', 'old'), message('assistant', 'same'), message('user', 'new')])).toEqual([
      message('assistant', 'same'), message('user', 'old'), message('assistant', 'same'), message('user', 'new'),
    ]);
  });
  it('keeps actual HTML/XML requests and text after native startup envelopes', () => {
    expect(visibleNativeUserText('<main>Fix this page</main>')).toBe('<main>Fix this page</main>');
    expect(visibleNativeUserText('<environment_context>metadata</environment_context>\nFix this page')).toBe('Fix this page');
    expect(visibleNativeUserText('<task-notification><status>stopped</status></task-notification>')).toBe('');
    expect(visibleNativeUserText('<task-notification><status>stopped</status></task-notification>\nWhat happened?')).toBe('What happened?');
  });
  it('removes native task notices and empty tool completion rows already imported into the cache', () => {
    const cached = [
      message('user', 'Run the proof'),
      message('assistant', 'Done'),
      message('assistant', 'Background work finished: tool.'),
      message('user', '<task-notification><task-id>__orphan_summary__:shell</task-id></task-notification>'),
    ];
    expect(mergeNativeTranscript(cached, cached)).toEqual(cached.slice(0, 2));
  });
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
    expect(mergeNativeTranscript(cached, source)).toEqual(source);
    expect(reconcileNativeTranscript(cached, source).appendedFrom).toBe(3);
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
  it('does not import Claude task notifications as user turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-claude-profile-'));
    const sessionDir = join(root, 'projects', '-workspace');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'thread.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'Run the proof' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Started it.' } }),
      JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><status>stopped</status></task-notification>' } }),
      JSON.stringify({ type: 'user', message: { content: 'What happened?' } }),
    ].join('\n'));
    try {
      await expect(readClaudeFsTranscript('thread', '/workspace', { CLAUDE_CONFIG_DIR: root })).resolves.toEqual([
        message('user', 'Run the proof'), message('assistant', 'Started it.'), message('user', 'What happened?'),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reads Claude suffix updates and restores an older native prefix when needed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-claude-sync-'));
    const sessionDir = join(root, 'projects', '-workspace');
    await mkdir(sessionDir, { recursive: true });
    const all = [
      message('user', 'older'), message('assistant', 'old answer'),
      message('user', 'cached'), message('assistant', 'cached answer'),
      message('user', 'new'), message('assistant', 'new answer'),
    ];
    const lines = all.map((item) => JSON.stringify({ type: item.role, message: { content: item.content } }));
    // Non-message records make the native file larger than the first tail window.
    await writeFile(join(sessionDir, 'thread.jsonl'), [lines[0], lines[1],
      JSON.stringify({ type: 'progress', data: 'x'.repeat(300_000) }), ...lines.slice(2)].join('\n'));
    try {
      const recent = await readClaudeFsTranscriptForSync('thread', '/workspace', all.slice(2, 4), { CLAUDE_CONFIG_DIR: root });
      expect(recent).toEqual(all);
      const cached = all.slice(0, 4);
      const source = await readClaudeFsTranscriptForSync('thread', '/workspace', cached, { CLAUDE_CONFIG_DIR: root });
      expect(reconcileNativeTranscript(cached, source).messages).toEqual(all);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
