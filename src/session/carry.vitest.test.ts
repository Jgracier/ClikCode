/** A vendor session belongs to the account whose profile it was written in.
 * Carrying the one file across is what lets a quota failover resume the
 * thread instead of seeding a fresh one with a retelling of it. */
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carryNativeSession } from './carry';
import { resetNativeSessionDiscoveryCache } from './discovery/cache';
import type { AiLocalHarnessDefinition } from '../harness/definition';

const harnessFor = (command: string): AiLocalHarnessDefinition => ({ command } as AiLocalHarnessDefinition);
const WORKSPACE = '/home/someone/projects/thing';

describe('carrying a vendor session between account profiles', () => {
  afterEach(() => { resetNativeSessionDiscoveryCache(); });

  it('puts a Claude Code transcript where the next account will look for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const from = join(root, 'account-a');
    const to = join(root, 'account-b');
    const project = WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-');
    await mkdir(join(from, 'projects', project), { recursive: true });
    await writeFile(join(from, 'projects', project, 'session-one.jsonl'), '{"type":"user"}\n', 'utf8');

    const carried = await carryNativeSession({
      harness: harnessFor('claude'),
      nativeId: 'session-one',
      workspace: WORKSPACE,
      from: { CLAUDE_CONFIG_DIR: from },
      to: { CLAUDE_CONFIG_DIR: to },
    });

    // The verb, plus the file itself: carryNativeSession reports WHETHER the
    // thread is reachable, not where it landed, so the landing is checked
    // directly rather than inferred from the return value.
    expect(carried).toBe('carried');
    await expect(readFile(join(to, 'projects', project, 'session-one.jsonl'), 'utf8')).resolves.toBe('{"type":"user"}\n');
    // Copied, never moved: the account that ran out keeps its own history.
    await expect(readFile(join(from, 'projects', project, 'session-one.jsonl'), 'utf8')).resolves.toBe('{"type":"user"}\n');
  });

  it("keeps Codex's dated rollout path", async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const from = join(root, 'account-a');
    const to = join(root, 'account-b');
    const day = join('sessions', '2026', '09', '20');
    const name = 'rollout-2026-09-20T08-00-00-11111111-2222-3333-4444-555555555555.jsonl';
    await mkdir(join(from, day), { recursive: true });
    await writeFile(join(from, day, name), '{"type":"response_item"}\n', 'utf8');

    const carried = await carryNativeSession({
      harness: harnessFor('codex'),
      nativeId: '11111111-2222-3333-4444-555555555555',
      workspace: WORKSPACE,
      from: { CODEX_HOME: from },
      to: { CODEX_HOME: to },
    });

    expect(carried).toBe('carried');
    await expect(readFile(join(to, day, name), 'utf8')).resolves.toBe('{"type":"response_item"}\n');
  });

  it('updates the copy waiting in a profile the conversation returns to', async () => {
    // A -> B -> A: A still holds the copy it had when the conversation left,
    // one switch out of date. Everything said while B owned the thread is only
    // in B's file, and the resume has to read that.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const a = join(root, 'account-a');
    const b = join(root, 'account-b');
    const project = WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-');
    const file = (home: string): string => join(home, 'projects', project, 'session-one.jsonl');
    await mkdir(join(a, 'projects', project), { recursive: true });
    await writeFile(file(a), '{"turn":1}\n', 'utf8');

    const carry = (from: string, to: string): ReturnType<typeof carryNativeSession> => carryNativeSession({
      harness: harnessFor('claude'),
      nativeId: 'session-one',
      workspace: WORKSPACE,
      from: { CLAUDE_CONFIG_DIR: from },
      to: { CLAUDE_CONFIG_DIR: to },
    });

    await expect(carry(a, b)).resolves.toBe('carried');
    // The thread keeps working under B, which appends to B's copy.
    await writeFile(file(b), '{"turn":1}\n{"turn":2}\n{"turn":3}\n', 'utf8');

    await expect(carry(b, a)).resolves.toBe('carried');
    await expect(readFile(file(a), 'utf8')).resolves.toBe('{"turn":1}\n{"turn":2}\n{"turn":3}\n');
    // And carrying the same file again is a no-op, not a rewrite.
    const before = (await stat(file(a))).mtimeMs;
    await expect(carry(b, a)).resolves.toBe('carried');
    expect((await stat(file(a))).mtimeMs).toBe(before);
  });

  it('reports nothing to carry rather than failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const profiles = { from: { CLAUDE_CONFIG_DIR: join(root, 'a') }, to: { CLAUDE_CONFIG_DIR: join(root, 'b') } };
    // No transcript on disk.
    await expect(carryNativeSession({
      harness: harnessFor('claude'), nativeId: 'missing', workspace: WORKSPACE, ...profiles,
    })).resolves.toBeUndefined();
    // A harness whose layout is not known.
    await expect(carryNativeSession({
      harness: harnessFor('gemini'), nativeId: 'session-one', workspace: WORKSPACE, ...profiles,
    })).resolves.toBeUndefined();
    // No session at all.
    await expect(carryNativeSession({
      harness: harnessFor('claude'), nativeId: undefined, workspace: WORKSPACE, ...profiles,
    })).resolves.toBeUndefined();
  });

  it('reports a shared profile as PRESENT, not as nothing to carry', async () => {
    // The distinction this whole type exists for. Both of these used to
    // return undefined -- the same answer as "this thread is unreachable" --
    // and the caller responded by discarding the thread id and re-sending the
    // entire conversation as a rehydration prompt. The thread had not moved.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));

    // Same profile path on both sides.
    await expect(carryNativeSession({
      harness: harnessFor('claude'), nativeId: 'session-one', workspace: WORKSPACE,
      from: { CLAUDE_CONFIG_DIR: join(root, 'a') }, to: { CLAUDE_CONFIG_DIR: join(root, 'a') },
    })).resolves.toBe('present');

    // And the case that covers most of the catalog: a harness with no
    // per-account profile at all. Fifteen of the twenty-four declare no
    // profileEnv, so every account runs against one vendor home and the
    // thread is always already in place.
    await expect(carryNativeSession({
      harness: harnessFor('opencode'), nativeId: 'session-one', workspace: WORKSPACE,
      from: {}, to: {},
    })).resolves.toBe('present');
  });

  it('still reports unreachable when the profiles genuinely differ', async () => {
    // A harness with an isolated profile whose on-disk layout is unknown:
    // the thread really is stranded in the losing account's home, and
    // re-seeding is the honest answer.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    await expect(carryNativeSession({
      harness: { command: 'gemini', profileEnv: 'GEMINI_CLI_HOME' } as AiLocalHarnessDefinition,
      nativeId: 'session-one', workspace: WORKSPACE,
      from: { GEMINI_CLI_HOME: join(root, 'a') }, to: { GEMINI_CLI_HOME: join(root, 'b') },
    })).resolves.toBeUndefined();
  });
});
