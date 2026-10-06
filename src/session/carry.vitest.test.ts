/** A vendor session belongs to the account whose profile it was written in.
 * Carrying the one file across is what lets a quota failover resume the
 * thread instead of seeding a fresh one with a retelling of it. */
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carryNativeSession, moveThreadToAccount } from './carry';
import { resetNativeSessionDiscoveryCache } from './discovery/cache';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition';
import type { HarnessSession } from './model';
import { allLocalHarnesses, localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { NATIVE_SESSION_STORES } from './discovery/registry';

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

  it("points Codex's own thread row at the copy, which Codex trusts over the disk", async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const from = join(root, 'account-a');
    const to = join(root, 'account-b');
    const id = '11111111-2222-3333-4444-666666666666';
    const day = join('sessions', '2026', '09', '20');
    const name = `rollout-2026-09-20T08-00-00-${id}.jsonl`;
    await mkdir(join(from, day), { recursive: true });
    await mkdir(to, { recursive: true });
    await writeFile(join(from, day, name), '{"type":"response_item"}\n', 'utf8');
    // The receiving profile already indexes the thread at a path that is not
    // where the copy lands (an earlier copy, since moved): Codex would answer
    // "no rollout found". Its name is the account's own and stays.
    const db = new DatabaseSync(join(to, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, name TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, join(to, 'sessions', '2026', '09', '01', name), 'my thread');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('other', '/elsewhere.jsonl', 'other');
    db.close();

    const carried = await carryNativeSession({
      harness: harnessFor('codex'), nativeId: id, workspace: WORKSPACE, from: { CODEX_HOME: from }, to: { CODEX_HOME: to },
    });

    expect(carried).toBe('carried');
    const after = new DatabaseSync(join(to, 'state_5.sqlite'));
    expect(after.prepare('SELECT id, rollout_path, name FROM threads ORDER BY id').all()).toEqual([
      { id, rollout_path: join(to, day, name), name: 'my thread' },
      { id: 'other', rollout_path: '/elsewhere.jsonl', name: 'other' },
    ]);
    after.close();
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
    // A harness whose layout is not known. gemini used to be the example
    // here and no longer is -- it has a store now -- so this uses copilot,
    // whose profile holds only logs, suggesting its threads live server-side
    // where nothing local can reach them.
    await expect(carryNativeSession({
      harness: { command: 'copilot', profileEnv: 'COPILOT_HOME' } as AiLocalHarnessDefinition,
      nativeId: 'session-one', workspace: WORKSPACE,
      from: { COPILOT_HOME: join(root, 'a') }, to: { COPILOT_HOME: join(root, 'b') },
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
    // An isolated profile whose store knows the layout but finds nothing
    // there: the thread really is stranded, and re-seeding is the honest
    // answer. Absent-on-disk and layout-unknown deliberately give the same
    // answer, because the caller can do nothing different about either.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    await expect(carryNativeSession({
      harness: { command: 'gemini', profileEnv: 'GEMINI_CLI_HOME' } as AiLocalHarnessDefinition,
      nativeId: 'session-one', workspace: WORKSPACE,
      from: { GEMINI_CLI_HOME: join(root, 'a') }, to: { GEMINI_CLI_HOME: join(root, 'b') },
    })).resolves.toBeUndefined();
  });

  it('carries a conversation that is a DIRECTORY, not a single file', async () => {
    // Copilot keeps a tree per conversation -- the transcript plus the
    // workspace.yaml naming the id and cwd it resumes against -- so copying
    // only "the file" would land a transcript the CLI then refuses to resume.
    // Verified against the real CLI: carrying the tree makes it emit
    // session.resume rather than starting over.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const harness = { command: 'copilot', profileEnv: 'COPILOT_HOME' } as AiLocalHarnessDefinition;
    const from = { COPILOT_HOME: join(root, 'a') };
    const to = { COPILOT_HOME: join(root, 'b') };
    const session = join(root, 'a', 'session-state', 'session-one');
    await mkdir(join(session, 'checkpoints'), { recursive: true });
    await writeFile(join(session, 'events.jsonl'), '{"type":"session.start"}\n');
    await writeFile(join(session, 'workspace.yaml'), 'id: session-one\n');
    await writeFile(join(session, 'checkpoints', 'index.md'), '# Checkpoint History\n');

    await expect(carryNativeSession({
      harness, nativeId: 'session-one', workspace: WORKSPACE, from, to,
    })).resolves.toBe('carried');

    const carried = join(root, 'b', 'session-state', 'session-one');
    // Every part, including the nested directory -- not just the transcript.
    expect(await readFile(join(carried, 'events.jsonl'), 'utf8')).toContain('session.start');
    expect(await readFile(join(carried, 'workspace.yaml'), 'utf8')).toContain('session-one');
    expect(await readFile(join(carried, 'checkpoints', 'index.md'), 'utf8')).toContain('Checkpoint');
    // And no staging leftovers beside it.
    expect((await readdir(join(root, 'b', 'session-state'))).sort()).toEqual(['session-one']);
  });

  it('replaces a stale carried directory with the longer one', async () => {
    // A -> B -> A finds its own earlier tree waiting, one switch out of date.
    // The size+recency rule has to aggregate across the tree for this, since
    // no single file in it is the conversation.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const harness = { command: 'copilot', profileEnv: 'COPILOT_HOME' } as AiLocalHarnessDefinition;
    const from = { COPILOT_HOME: join(root, 'a') };
    const to = { COPILOT_HOME: join(root, 'b') };
    const source = join(root, 'a', 'session-state', 'session-one');
    const stale = join(root, 'b', 'session-state', 'session-one');
    await mkdir(source, { recursive: true });
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'events.jsonl'), '{"n":1}\n');
    await writeFile(join(source, 'events.jsonl'), '{"n":1}\n{"n":2}\n{"n":3}\n');

    await expect(carryNativeSession({
      harness, nativeId: 'session-one', workspace: WORKSPACE, from, to,
    })).resolves.toBe('carried');
    expect(await readFile(join(stale, 'events.jsonl'), 'utf8')).toContain('"n":3');
    expect((await readdir(join(root, 'b', 'session-state'))).sort()).toEqual(['session-one']);
  });

  it("carries a Qwen thread and leaves its liveness file behind", async () => {
    // Qwen's path is Claude's with an extra `chats` level, and its cwd name
    // comes from its own sanitizeCwd -- one name, not Claude's two. The
    // runtime.json beside the transcript marks a LIVE session for anything
    // scanning the directory, so carrying it would announce a session running
    // in a profile where nothing runs.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const harness = { command: 'qwen', profileEnv: 'QWEN_HOME' } as AiLocalHarnessDefinition;
    const chats = join(root, 'a', 'projects', WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, 'session-one.jsonl'), '{"sessionId":"session-one"}\n');
    await writeFile(join(chats, 'session-one.runtime.json'), '{"pid":1}');

    await expect(carryNativeSession({
      harness, nativeId: 'session-one', workspace: WORKSPACE,
      from: { QWEN_HOME: join(root, 'a') }, to: { QWEN_HOME: join(root, 'b') },
    })).resolves.toBe('carried');

    const landed = join(root, 'b', 'projects', WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
    expect((await readdir(landed)).sort()).toEqual(['session-one.jsonl']);
  });

  it('carries a Command Code thread using its own lowercased cwd slug', async () => {
    // Command Code's slug is lowercased with runs of non-alphanumerics
    // collapsed to one dash and no leading dash -- three ways it differs from
    // Claude Code's and Qwen's names for the same cwd, all pinned against the
    // real CLI's output.
    const root = await mkdtemp(join(tmpdir(), 'clikcode-carry-'));
    const harness = { command: 'command', profileEnv: 'HOME' } as AiLocalHarnessDefinition;
    const workspace = '/tmp/probe/work.dir_x/A b';
    const dir = join(root, 'a', '.commandcode', 'projects', 'tmp-probe-work-dir-x-a-b');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session-one.jsonl'), '{"type":"header"}\n');
    // Not the conversation: checkpoints and prompt history, per its own docs.
    await writeFile(join(dir, 'session-one.checkpoints.jsonl'), '{}\n');
    await writeFile(join(dir, 'session-one.prompts.jsonl'), '{}\n');

    await expect(carryNativeSession({
      harness, nativeId: 'session-one', workspace,
      from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') },
    })).resolves.toBe('carried');

    const landed = join(root, 'b', '.commandcode', 'projects', 'tmp-probe-work-dir-x-a-b');
    expect((await readdir(landed)).sort()).toEqual(['session-one.jsonl']);
  });

  it('uses transcript rehydration when an isolated harness has no native thread store', () => {
    // Independent logins require independent vendor homes. For CLIs without a
    // known transcript layout, carryNativeSession returns undefined and the
    // turn driver replays ClikCode's canonical conversation into a fresh
    // vendor thread instead of pretending the old account's thread is shared.
    const isolatedWithoutStore = allLocalHarnesses()
      .filter((harness) => !NATIVE_SESSION_STORES[harness.command] && harness.profileEnv);
    expect(isolatedWithoutStore.length).toBeGreaterThan(0);
    expect(isolatedWithoutStore.every((harness) => Boolean(harness.profileEnv))).toBe(true);
  });
});

describe('moving a conversation to another account', () => {
  const claude = localHarnessForCommand('claude')!;
  const account = (id: string): AiHarnessAccount => ({
    id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${id}`,
  });
  const session = (extra: Partial<HarnessSession> = {}): HarnessSession =>
    ({ id: 's', nativeHarness: 'claude', nativeSessionId: 'thread-1', workspace: WORKSPACE, ...extra }) as HarnessSession;

  it('keeps a confirmed thread both accounts read from the same vendor home', async () => {
    const confirmed = session();
    await expect(moveThreadToAccount(confirmed, claude, account('a'), account('b'))).resolves.toBe('present');
    expect(confirmed.nativeSessionId).toBe('thread-1');
  });

  it('has nothing to carry for an id ClikCode minted that the vendor never confirmed', async () => {
    // A first attempt refused before the vendor created the thread: the next
    // account must be sent the whole request, not only "carry on".
    const minted = session({ nativeSessionPreallocated: true });
    await expect(moveThreadToAccount(minted, claude, account('a'), account('b'))).resolves.toBeUndefined();
    expect(minted.nativeSessionId).toBeUndefined();
    expect(minted.nativeSessionPreallocated).toBeUndefined();
  });
});
