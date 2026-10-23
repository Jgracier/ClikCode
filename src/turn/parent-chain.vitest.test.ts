import { describe, expect, it } from 'vitest';
import { parentChainHolds } from './parent-chain.js';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);

describe('parentChainHolds', () => {
  it('resumes a chain that still links every stored prompt', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'first' } }),
      line({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: [{ type: 'text', text: 'ok' }] } }),
      line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'second' } }),
    ].join('\n');
    expect(parentChainHolds(jsonl)).toBe(true);
  });

  it('resumes a valid compaction summary', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'first' } }),
      line({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'second' } }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'root', parentUuid: null }),
      line({ type: 'user', uuid: 's', parentUuid: 'root', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'summary' } }),
      line({ type: 'user', uuid: 'c', parentUuid: 's', message: { content: 'latest' } }),
    ].join('\n');
    expect(parentChainHolds(jsonl)).toBe(true);
  });

  it('ignores an abandoned branch when the active branch is linked', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'first' } }),
      line({ type: 'user', uuid: 'old', parentUuid: 'a', message: { content: 'abandoned' } }),
      line({ type: 'user', uuid: 'latest', parentUuid: 'a', message: { content: 'active' } }),
    ].join('\n');
    expect(parentChainHolds(jsonl)).toBe(true);
  });

  it('does not resume a chain whose parent is missing', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'first' } }),
      line({ type: 'user', uuid: 'b', parentUuid: 'gone', message: { content: 'latest' } }),
    ].join('\n');
    expect(parentChainHolds(jsonl)).toBe(false);
  });

  it('does not resume a cyclic chain', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'a', parentUuid: 'b', message: { content: 'first' } }),
      line({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'latest' } }),
    ].join('\n');
    expect(parentChainHolds(jsonl)).toBe(false);
  });

  it('rejects a file with no usable parent chain', () => {
    expect(parentChainHolds(line({ type: 'event', uuid: 'a', text: 'hello' }))).toBe(false);
    expect(parentChainHolds('')).toBe(false);
  });
});
